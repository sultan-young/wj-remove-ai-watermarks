import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { Config } from './config.js';
import { engineConfig, type Options } from './options.js';
import { ServiceError } from './errors.js';
import { WorkerClient, WorkerFailure } from './worker.js';
import { validateImage } from './images.js';

type State = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type Job = {
  id: string; status: State; stage: string; dir: string; input: string; output: string;
  manifest?: string; options: Options; source: 'upload' | 'url';
  created: number; started?: number; finished?: number; inputInfo: { width: number; height: number; format: string };
  error?: { code: string; message: string }; effective?: unknown;
  result?: { width: number; height: number; format: string; bytes: number; sha256: string };
  expired: boolean; downloads: number; downloadedAt?: number; acknowledgedAt?: number; cancelRequested: boolean;
};
type Slot = { client: WorkerClient; busy: boolean; recovering: boolean; retryAt: number };
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
  constructor(readonly config: Config, readonly runDir: string, private log: (message: string) => void) {
    this.slots = Array.from({ length: config.concurrency }, (_, index) => ({
      client: new WorkerClient(index, config, message => log(`[worker ${index}] ${message}`)), busy: false, recovering: false, retryAt: 0,
    }));
  }
  start() {
    this.timer = setInterval(() => { this.pump(); void this.cleanup().catch(e => this.log(`cleanup: ${e.message}`)); }, 1000);
    this.timer.unref(); this.pump();
  }
  beginIntake() {
    if (this.closed || this.draining) throw new ServiceError(503, 'DRAINING', 'Server is not accepting new tasks');
    if (this.intakes + this.queue.length >= this.config.maxQueue) throw new ServiceError(429, 'QUEUE_FULL', 'Queue is full');
    if (this.jobs.size + this.intakes >= this.config.maxRecords) throw new ServiceError(429, 'TASK_RECORD_LIMIT', 'Task record limit reached; delete finished tasks');
    this.intakes++;
    let released = false;
    return () => { if (!released) { released = true; this.intakes--; } };
  }
  async newDir() {
    const id = randomUUID(); const dir = path.join(this.runDir, id);
    await mkdir(dir, { mode: 0o700 }); return { id, dir };
  }
  enqueue(job: Job, key: string | undefined, fingerprint: string) {
    if (key) {
      const old = this.keys.get(key);
      if (old) {
        if (old.fingerprint !== fingerprint) throw new ServiceError(409, 'IDEMPOTENCY_CONFLICT', 'Key already used with different input or options');
        const existing = this.jobs.get(old.id);
        if (existing) return { job: existing, reused: true };
      }
      this.keys.set(key, { fingerprint, id: job.id });
    }
    this.jobs.set(job.id, job); this.queue.push(job.id); this.pump(); return { job, reused: false };
  }
  get(id: string) {
    const job = this.jobs.get(id);
    if (!job) throw new ServiceError(404, 'JOB_NOT_FOUND', 'Task not found in this service session');
    return job;
  }
  view(job: Job) {
    const { id, status, stage, options, source, error, effective, result, expired, inputInfo } = job;
    return { id, status, stage, progress: null, source, options, effective: effective ?? null, input: inputInfo,
      created_at: new Date(job.created).toISOString(), started_at: job.started ? new Date(job.started).toISOString() : null,
      finished_at: job.finished ? new Date(job.finished).toISOString() : null,
      elapsed_seconds: job.started ? ((job.finished ?? Date.now()) - job.started) / 1000 : null,
      error: error ?? null, result: result ? { ...result, expired, downloaded_at: job.downloadedAt ? new Date(job.downloadedAt).toISOString() : null,
        acknowledged_at: job.acknowledgedAt ? new Date(job.acknowledgedAt).toISOString() : null,
        download_path: `/v1/jobs/${id}/result` } : null,
      worker_mode: this.config.workerMode,
    };
  }
  status() {
    const queued = this.queue.length, running = this.slots.filter(s => s.busy).length;
    const uncollected = [...this.jobs.values()].filter(j => j.status === 'succeeded' && !j.expired && !j.acknowledgedAt).length;
    return { draining: this.draining, intake_count: this.intakes, queued, running,
      active_downloads: [...this.jobs.values()].reduce((n, j) => n + j.downloads, 0),
      uncollected_results: uncollected,
      safe_to_stop: this.draining && this.intakes === 0 && queued === 0 && running === 0 && uncollected === 0 && [...this.jobs.values()].every(j => j.downloads === 0),
      concurrency: this.config.concurrency, worker_mode: this.config.workerMode,
      workers: this.slots.map(s => ({ index: s.client.index, ready: s.client.ready, busy: s.busy, recovering: s.recovering, last_error: s.client.lastError, info: s.client.info })),
    };
  }
  cancel(id: string) {
    const job = this.get(id);
    if (job.status === 'queued') {
      this.queue = this.queue.filter(x => x !== id); job.status = 'cancelled'; job.stage = 'cancelled'; job.finished = Date.now();
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
    for (const slot of this.slots) {
      if (slot.busy || slot.recovering) continue;
      if (!slot.client.ready) {
        if (Date.now() < slot.retryAt) continue;
        slot.recovering = true;
        const defaults = { pipeline: this.config.defaultPipeline, controlnet_scale: 1, cpu_offload: false };
        void slot.client.start(defaults).catch(e => { this.log(`worker initialization: ${e.message}`); slot.retryAt = Date.now() + this.config.restartDelayMs; })
          .finally(() => { slot.recovering = false; this.pump(); });
        continue;
      }
      const id = this.queue.shift();
      if (!id) continue;
      const job = this.jobs.get(id)!;
      slot.busy = true; (slot as Slot & { jobId?: string }).jobId = id;
      job.status = 'running'; job.stage = 'preparing'; job.started = Date.now();
      void this.execute(slot, job).finally(() => { slot.busy = false; (slot as Slot & { jobId?: string }).jobId = undefined; this.pump(); });
    }
  }
  private async execute(slot: Slot, job: Job) {
    try {
      const mode = job.options.processing.mode;
      const engine = mode === 'metadata' || mode === 'visible' ? null : engineConfig(job.options);
      const event = await slot.client.run({ id: job.id, input: job.input, output: path.join(job.dir, 'result.tmp.png'), manifest: job.manifest, options: job.options },
        engine, event => { if (event.type === 'stage' && typeof event.stage === 'string') job.stage = event.stage; });
      if (job.cancelRequested) throw new Error('Cancelled');
      job.stage = 'validating_output';
      const tmp = path.join(job.dir, 'result.tmp.png');
      const info = await validateImage(tmp, this.config.maxPixels);
      if (info.format !== 'png' || info.width !== job.inputInfo.width || info.height !== job.inputInfo.height) throw new Error('Unexpected output geometry or format');
      const size = (await stat(tmp)).size;
      const sha256 = createHash('sha256').update(await readFile(tmp)).digest('hex');
      if (job.cancelRequested) throw new Error('Cancelled');
      await rename(tmp, job.output);
      if (job.cancelRequested) { await rm(job.output, { force: true }); throw new Error('Cancelled'); }
      job.effective = event.effective; job.result = { ...info, bytes: size, sha256 };
      job.status = 'succeeded'; job.stage = 'completed';
    } catch (error) {
      const code = error instanceof WorkerFailure ? error.code : 'PROCESSING_FAILED';
      this.log(`job ${job.id}: ${code}: ${error instanceof Error ? error.message : String(error)}`);
      job.status = job.cancelRequested ? 'cancelled' : 'failed'; job.stage = job.status;
      if (!job.cancelRequested) job.error = { code, message: 'Processing failed; inspect server logs with this task ID' };
      await rm(path.join(job.dir, 'result.tmp.png'), { force: true }).catch(() => {});
    } finally { job.finished = Date.now(); }
  }
  async cleanup() {
    const now = Date.now();
    this.queue = this.queue.filter(id => {
      const job = this.jobs.get(id)!;
      if (now - job.created < this.config.queueTimeoutMs) return true;
      job.status = 'failed'; job.stage = 'failed'; job.finished = now;
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
