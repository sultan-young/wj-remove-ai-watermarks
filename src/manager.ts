import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { Config } from './config.js';
import { engineConfig, type Options } from './options.js';
import { ServiceError } from './errors.js';
import { WorkerClient, WorkerFailure, type WorkerEvent } from './worker.js';
import { validateImage } from './images.js';
import { downloadImage } from './download.js';
import {
  beginStage, finishOpenStage, progressFromStages, publicStages, sealStage, type StageClock, type StageDetail,
} from './stages.js';
import { publishResult, storageConfigured } from './storage/index.js';

type State = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type Job = StageClock & {
  id: string; status: State; dir: string; input: string; output: string;
  manifest?: string; options: Options; source: 'upload' | 'url';
  created: number; started?: number; finished?: number; inputInfo: { width: number; height: number; format: string } | null;
  error?: { code: string; message: string }; effective?: unknown;
  result?: {
    width: number; height: number; format: string; bytes: number; sha256: string;
    url?: string; key?: string;
  };
  expired: boolean; downloads: number; downloadedAt?: number; acknowledgedAt?: number; cancelRequested: boolean;
};
type Slot = { client: WorkerClient; busy: boolean; recovering: boolean; retryAt: number; lastBusyEnded: number; idleNoted: boolean };
export class Manager {
  jobs = new Map<string, Job>();
  private keys = new Map<string, { fingerprint: string; id: string }>();
  private queue: string[] = [];
  slots: Slot[];
  draining = false;
  intakes = 0;
  private closed = false;
  private timer?: NodeJS.Timeout;
  private lastOrphanCleanup = 0;
  /** 算完后的上传队列。Worker 槽位不等待这里。 */
  private uploadQueue: Job[] = [];
  private uploading = 0;
  private readonly uploadConcurrency = 2;
  private uploadAttempts = new Map<string, number>();
  /** 已收下、还在下载原图的任务。不占 Worker。 */
  private fetching = 0;
  private fetchAborts = new Map<string, AbortController>();
  constructor(readonly config: Config, readonly runDir: string, private log: (message: string) => void) {
    this.slots = Array.from({ length: config.devices.length }, (_, index) => ({
      client: new WorkerClient(index, config, message => log(`[worker ${index}] ${message}`)), busy: false, recovering: false, retryAt: 0, lastBusyEnded: 0, idleNoted: false,
    }));
  }
  start() {
    this.timer = setInterval(() => { this.pump(); void this.cleanup().catch(e => this.log(`cleanup: ${e.message}`)); }, 1000);
    this.timer.unref(); this.pump();
  }
  beginIntake() {
    if (this.closed || this.draining) throw new ServiceError(503, 'DRAINING', 'Server is not accepting new tasks');
    if (this.intakes + this.queue.length + this.fetching >= this.config.maxQueue) throw new ServiceError(429, 'QUEUE_FULL', 'Queue is full');
    if (this.jobs.size + this.intakes >= this.config.maxRecords) throw new ServiceError(429, 'TASK_RECORD_LIMIT', 'Task record limit reached; delete finished tasks');
    this.intakes++;
    let released = false;
    return () => { if (!released) { released = true; this.intakes--; } };
  }
  async newDir() {
    const id = randomUUID(); const dir = path.join(this.runDir, id);
    await mkdir(dir, { mode: 0o700 }); return { id, dir };
  }
  private remember(job: Job, key: string | undefined, fingerprint: string) {
    if (key) {
      const old = this.keys.get(key);
      if (old) {
        if (old.fingerprint !== fingerprint) throw new ServiceError(409, 'IDEMPOTENCY_CONFLICT', 'Key already used with different input or options');
        const existing = this.jobs.get(old.id);
        if (existing) return { job: existing, reused: true as const };
      }
      this.keys.set(key, { fingerprint, id: job.id });
    }
    this.jobs.set(job.id, job);
    return { job, reused: false as const };
  }
  enqueue(job: Job, key: string | undefined, fingerprint: string) {
    const saved = this.remember(job, key, fingerprint);
    if (saved.reused) return saved;
    this.queue.push(job.id); this.pump(); return saved;
  }
  /** URL 任务先返回。下载和校验在后台完成，通过后才进入计算队列。 */
  acceptFetch(job: Job, key: string | undefined, fingerprint: string, url: string) {
    const saved = this.remember(job, key, fingerprint);
    if (saved.reused) return saved;
    beginStage(job, 'fetching');
    this.fetching++;
    this.log(`pipeline fetch-start job=${job.id} fetching=${this.fetching}`);
    const started = Date.now();
    const abort = new AbortController();
    this.fetchAborts.set(job.id, abort);
    void this.fetchThenEnqueue(job, url, abort, started).finally(() => {
      this.fetching = Math.max(0, this.fetching - 1);
      this.fetchAborts.delete(job.id);
    });
    return saved;
  }
  private async fetchThenEnqueue(job: Job, url: string, abort: AbortController, started: number) {
    const input = job.input;
    try {
      if (job.cancelRequested || this.closed) throw new ServiceError(499, 'CANCELLED', 'Cancelled');
      await downloadImage(url, input, this.config, abort.signal);
      if (job.cancelRequested || this.closed) throw new ServiceError(499, 'CANCELLED', 'Cancelled');
      const info = await validateImage(input, this.config.maxPixels);
      const typedInput = path.join(job.dir, `input.${info.format === 'jpeg' ? 'jpg' : info.format}`);
      await rename(input, typedInput);
      job.input = typedInput;
      job.inputInfo = info;
      if (job.cancelRequested || this.closed) throw new ServiceError(499, 'CANCELLED', 'Cancelled');
      this.queue.push(job.id);
      beginStage(job, 'queued');
      this.log(`pipeline fetch-done job=${job.id} ms=${Date.now() - started} queue=${this.queue.length}`);
      this.pump();
    } catch (error) {
      if (job.status !== 'queued') return;
      const cancelled = job.cancelRequested || (error instanceof ServiceError && error.code === 'CANCELLED');
      await rm(job.dir, { recursive: true, force: true }).catch(() => {});
      if (job.status !== 'queued') return;
      job.status = cancelled ? 'cancelled' : 'failed';
      sealStage(job, job.status);
      if (!cancelled) {
        const code = error instanceof ServiceError ? error.code : 'URL_FETCH_FAILED';
        const message = error instanceof Error ? error.message : String(error);
        job.error = { code, message };
        this.log(`pipeline fetch-fail job=${job.id} ms=${Date.now() - started} code=${code} message=${message}`);
      }
      job.finished = Date.now();
    }
  }
  get(id: string) {
    const job = this.jobs.get(id);
    if (!job) throw new ServiceError(404, 'JOB_NOT_FOUND', 'Task not found in this service session');
    return job;
  }
  query(ids: string[]) {
    return ids.map(id => {
      const job = this.jobs.get(id);
      return job ? this.view(job) : { id, status: 'missing' as const };
    });
  }
  view(job: Job) {
    const { id, status, stage, options, source, error, effective, result, expired, inputInfo } = job;
    const now = Date.now();
    return { id, status, stage, progress: progressFromStages(job), source, options, effective: effective ?? null, input: inputInfo,
      created_at: new Date(job.created).toISOString(), started_at: job.started ? new Date(job.started).toISOString() : null,
      finished_at: job.finished ? new Date(job.finished).toISOString() : null,
      stage_started_at: job.stageStartedAt ? new Date(job.stageStartedAt).toISOString() : null,
      queue_wait_seconds: job.started ? (job.started - job.created) / 1000 : (now - job.created) / 1000,
      elapsed_seconds: job.started ? ((job.finished ?? now) - job.started) / 1000 : null,
      stages: publicStages(job),
      error: error ?? null, result: result ? { ...result, expired, downloaded_at: job.downloadedAt ? new Date(job.downloadedAt).toISOString() : null,
        acknowledged_at: job.acknowledgedAt ? new Date(job.acknowledgedAt).toISOString() : null,
        download_path: `/v1/jobs/${id}/result` } : null,
      worker_mode: this.config.workerMode,
    };
  }
  status() {
    const queued = this.queue.length + this.fetching, running = this.slots.filter(s => s.busy).length;
    const uncollected = [...this.jobs.values()].filter(j => j.status === 'succeeded' && !j.expired && !j.acknowledgedAt).length;
    return { draining: this.draining, intake_count: this.intakes, queued, running,
      active_downloads: [...this.jobs.values()].reduce((n, j) => n + j.downloads, 0),
      uncollected_results: uncollected,
      safe_to_stop: this.draining && this.intakes === 0 && queued === 0 && running === 0 && uncollected === 0 && this.fetching === 0 && this.uploading === 0 && this.uploadQueue.length === 0 && [...this.jobs.values()].every(j => j.downloads === 0),
      concurrency: this.config.devices.length, worker_mode: this.config.workerMode,
      workers: this.slots.map(s => ({ index: s.client.index, ready: s.client.ready, busy: s.busy, recovering: s.recovering, last_error: s.client.lastError, info: s.client.info })),
    };
  }
  cancel(id: string) {
    const job = this.get(id);
    if (job.status === 'queued' && this.fetchAborts.has(id)) {
      job.cancelRequested = true;
      this.fetchAborts.get(id)!.abort();
    } else if (job.status === 'queued') {
      this.queue = this.queue.filter(x => x !== id);
      job.status = 'cancelled';
      sealStage(job, 'cancelled');
      job.finished = Date.now();
    } else if (job.status === 'running') {
      job.cancelRequested = true;
      // Stop only this slot. Other workers keep running. A model reload is necessary afterwards.
      const slot = this.slots.find(s => (s as Slot & { jobId?: string }).jobId === id);
      if (slot) void slot.client.stop();
    }
    return this.view(job);
  }
  async delete(id: string) {
    const job = this.get(id);
    if (['running', 'queued'].includes(job.status) || job.downloads) throw new ServiceError(409, 'JOB_BUSY', 'Task or download is active');
    await rm(job.dir, { recursive: true, force: true }); this.jobs.delete(id);
    for (const [key, value] of this.keys) if (value.id === id) this.keys.delete(key);
  }
  private pump() {
    if (this.closed) return;
    for (const [index, slot] of this.slots.entries()) {
      if (slot.busy || slot.recovering) continue;
      if (!slot.client.ready) {
        if (Date.now() < slot.retryAt) continue;
        slot.recovering = true;
        const pipeline = this.config.enabled.includes('qwen-zimage') ? 'qwen-zimage' : this.config.enabled[0]!;
        const defaults = { pipeline, controlnet_conditioning_scale: 1, cpu_offload: false };
        void slot.client.start(defaults).catch(e => { this.log(`worker initialization: ${e.message}`); slot.retryAt = Date.now() + this.config.restartDelayMs; })
          .finally(() => { slot.recovering = false; this.pump(); });
        continue;
      }
      const id = this.queue.shift();
      if (!id) {
        if (slot.client.ready && !slot.idleNoted) {
          const idleMs = slot.lastBusyEnded ? Date.now() - slot.lastBusyEnded : 0;
          this.log(`pipeline slot-idle slot=${index} idle_ms=${idleMs} queue=0 fetching=${this.fetching} uploading=${this.uploading}`);
          slot.idleNoted = true;
        }
        continue;
      }
      const job = this.jobs.get(id)!;
      slot.busy = true;
      slot.idleNoted = false;
      (slot as Slot & { jobId?: string }).jobId = id;
      const idleMs = slot.lastBusyEnded ? Date.now() - slot.lastBusyEnded : 0;
      job.status = 'running'; job.started = Date.now();
      this.log(`pipeline compute-start job=${job.id} slot=${index} idle_ms=${idleMs} queue_left=${this.queue.length} fetching=${this.fetching}`);
      beginStage(job, 'preparing');
      void this.execute(slot, job).finally(() => {
        slot.busy = false;
        slot.lastBusyEnded = Date.now();
        (slot as Slot & { jobId?: string }).jobId = undefined;
        this.pump();
      });
    }
  }
  private applyWorkerStage(job: Job, event: WorkerEvent) {
    const stage = event.stage;
    if (typeof stage !== 'string' || !stage.trim()) return;
    const raw = event.detail;
    const detail = raw && typeof raw === 'object' && !Array.isArray(raw)
      ? raw as StageDetail : undefined;
    beginStage(job, stage, detail);
  }
  private async execute(slot: Slot, job: Job) {
    try {
      const mode = job.options.processing.mode;
      const engine = mode === 'metadata' || mode === 'visible' ? null : engineConfig(job.options);
      const event = await slot.client.run({ id: job.id, input: job.input, output: path.join(job.dir, 'result.tmp.png'), manifest: job.manifest, options: job.options },
        engine, event => { if (event.type === 'stage') this.applyWorkerStage(job, event); });
      if (job.cancelRequested) throw new Error('Cancelled');
      beginStage(job, 'validating_output');
      const tmp = path.join(job.dir, 'result.tmp.png');
      const info = await validateImage(tmp, this.config.maxPixels);
      const source = job.inputInfo;
      if (!source || info.format !== 'png' || info.width !== source.width || info.height !== source.height) throw new Error('Unexpected output geometry or format');
      const size = (await stat(tmp)).size;
      const sha256 = createHash('sha256').update(await readFile(tmp)).digest('hex');
      if (job.cancelRequested) throw new Error('Cancelled');
      await rename(tmp, job.output);
      if (job.cancelRequested) { await rm(job.output, { force: true }); throw new Error('Cancelled'); }
      job.effective = event.effective;
      job.result = { ...info, bytes: size, sha256 };
      this.log(`pipeline compute-done job=${job.id} ms=${Date.now() - (job.started ?? Date.now())}`);
      if (storageConfigured(this.config)) {
        this.enqueueUpload(job);
        return;
      }
      this.complete(job);
    } catch (error) {
      const code = error instanceof WorkerFailure
        ? error.code
        : error instanceof ServiceError
          ? error.code
          : 'PROCESSING_FAILED';
      this.log(`job ${job.id}: ${code}: ${error instanceof Error ? error.message : String(error)}`);
      job.status = job.cancelRequested ? 'cancelled' : 'failed';
      sealStage(job, job.status);
      if (!job.cancelRequested) {
        const message = error instanceof Error ? error.message.trim() : String(error).trim();
        job.error = { code, message: message || 'Processing failed' };
      }
      await rm(path.join(job.dir, 'result.tmp.png'), { force: true }).catch(() => {});
      this.noteFinished(job);
    }
  }
  private complete(job: Job) {
    job.status = 'succeeded';
    sealStage(job, 'completed');
    this.noteFinished(job);
  }
  private noteFinished(job: Job) {
    if (!job.finished) job.finished = Date.now();
    finishOpenStage(job);
  }
  private enqueueUpload(job: Job) {
    beginStage(job, 'publishing');
    this.uploadQueue.push(job);
    this.pumpUploads();
  }
  private pumpUploads() {
    if (this.closed) return;
    while (this.uploading < this.uploadConcurrency && this.uploadQueue.length) {
      const job = this.uploadQueue.shift()!;
      this.uploading++;
      void this.publishJob(job).finally(() => {
        this.uploading--;
        this.pumpUploads();
      });
    }
  }
  private async publishJob(job: Job) {
    if (job.status !== 'running') return;
    if (job.cancelRequested) {
      job.status = 'cancelled';
      sealStage(job, 'cancelled');
      this.noteFinished(job);
      return;
    }
    const started = Date.now();
    this.log(`pipeline upload-start job=${job.id} uploading=${this.uploading}`);
    try {
      const uploaded = await publishResult(this.config, job.output, `${job.id}.png`);
      this.log(`pipeline upload-done job=${job.id} ms=${Date.now() - started} bytes=${job.result?.bytes ?? 0}`);
      if (job.status !== 'running') return;
      job.result = { ...job.result!, url: uploaded.url, key: uploaded.key };
      job.acknowledgedAt ??= Date.now();
      this.complete(job);
      this.uploadAttempts.delete(job.id);
    } catch (error) {
      const attempt = (this.uploadAttempts.get(job.id) ?? 0) + 1;
      this.uploadAttempts.set(job.id, attempt);
      const message = error instanceof Error ? error.message : String(error);
      if (attempt < 5 && !this.closed && job.status === 'running') {
        this.log(`job ${job.id}: upload retry ${attempt}: ${message}`);
        const delay = Math.min(30_000, 1000 * 2 ** (attempt - 1));
        const timer = setTimeout(() => {
          if (!this.closed && job.status === 'running') {
            this.uploadQueue.push(job);
            this.pumpUploads();
          }
        }, delay);
        timer.unref?.();
        return;
      }
      this.log(`job ${job.id}: STORAGE_UPLOAD_FAILED: ${message}`);
      job.status = 'failed';
      job.error = { code: 'STORAGE_UPLOAD_FAILED', message: message || 'Result upload failed' };
      sealStage(job, 'failed');
      this.noteFinished(job);
    }
  }
  async cleanup() {
    const now = Date.now();
    this.queue = this.queue.filter(id => {
      const job = this.jobs.get(id)!;
      if (now - job.created < this.config.queueTimeoutMs) return true;
      job.status = 'failed';
      sealStage(job, 'failed', now);
      job.finished = now;
      job.error = { code: 'QUEUE_TIMEOUT', message: 'Task exceeded queue wait limit; check worker readiness' };
      return false;
    });
    if (now - this.lastOrphanCleanup > 60000) {
      this.lastOrphanCleanup = now;
      await cleanupOldRuns(path.dirname(this.runDir), this.config.retentionMs, this.runDir);
    }
    for (const job of this.jobs.values()) {
      if (!job.finished || job.downloads || now - job.finished < this.config.retentionMs) continue;
      if (!job.expired) { job.expired = true; await rm(job.dir, { recursive: true, force: true }); }
      if (now - job.finished >= this.config.retentionMs * 2) {
        this.jobs.delete(job.id); for (const [key, value] of this.keys) if (value.id === job.id) this.keys.delete(key);
      }
    }
  }
  async close() {
    this.closed = true; clearInterval(this.timer);
    for (const abort of this.fetchAborts.values()) abort.abort();
    await Promise.all(this.slots.map(s => s.client.stop()));
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path.join(this.runDir, 'owner.json'), JSON.stringify({ pid: process.pid, created: Date.now(), stopped: true }), { mode: 0o600 });
    // State intentionally is not restored after restart. Files survive until orphan cleanup.
  }
}

async function processIdentity(pid: number) {
  try { return (await readFile(`/proc/${pid}/stat`, 'utf8')).split(') ').slice(1).join(') ').split(' ')[19]; }
  catch { return null; }
}
async function cleanupOldRuns(runs: string, ttl: number, current?: string) {
  for (const entry of await readdir(runs, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(runs, entry.name);
    if (dir === current) continue;
    try {
      const owner = JSON.parse(await readFile(path.join(dir, 'owner.json'), 'utf8')) as { pid: number; created: number; stopped?: boolean; identity?: string | null };
      let alive = true; try { process.kill(owner.pid, 0); } catch (e) { alive = (e as NodeJS.ErrnoException).code !== 'ESRCH'; }
      if (alive && owner.identity && await processIdentity(owner.pid) !== owner.identity) alive = false;
      if ((owner.stopped || !alive) && Date.now() - owner.created > ttl) await rm(dir, { recursive: true, force: true });
    } catch { /* Never delete an unrecognized directory. */ }
  }
}
export async function createRunDir(config: Config) {
  const runs = path.join(config.dataDir, 'runs'); await mkdir(runs, { recursive: true, mode: 0o700 });
  await cleanupOldRuns(runs, config.retentionMs);
  const dir = path.join(runs, randomUUID()); await mkdir(dir, { mode: 0o700 });
  const { writeFile } = await import('node:fs/promises');
  await writeFile(path.join(dir, 'owner.json'), JSON.stringify({ pid: process.pid, created: Date.now(), identity: await processIdentity(process.pid) }), { mode: 0o600 });
  return dir;
}
