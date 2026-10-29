import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import type { Config } from './config.js';
import type { EngineConfig, Options } from './options.js';

export type WorkerEvent = { protocol: number; type: string; job_id?: string; [key: string]: unknown };
export class WorkerFailure extends Error {
  constructor(public code: string, message: string) { super(message); }
}
// The Python loop stays up after a task error. Recycle only when the process is stuck or no longer usable.
const recycleWorker = new Set([
  'TASK_TIMEOUT', 'WORKER_EXITED', 'WORKER_PROTOCOL_ERROR', 'WORKER_WRITE_FAILED',
  'WORKER_INIT_FAILED', 'WORKER_INIT_TIMEOUT', 'WORKER_START_FAILED', 'CUDA_OOM',
]);
export class WorkerClient {
  ready = false;
  info: Record<string, unknown> = {};
  lastError: string | null = null;
  child?: ChildProcess;
  private key = '';
  private closing?: Promise<void>;
  private readyResolve?: () => void;
  private readyReject?: (error: Error) => void;
  private pending?: { id: string; resolve: (event: WorkerEvent) => void; reject: (e: Error) => void; event: (e: WorkerEvent) => void };
  constructor(readonly index: number, private config: Config, private log: (message: string) => void) {}

  async start(engine: EngineConfig) {
    await this.stop();
    this.key = JSON.stringify(engine);
    const gpu = this.config.devices[this.index % this.config.devices.length]!;
    const child = spawn(this.config.python, ['-u', this.config.workerPath], {
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...this.config.workerEnv, CUDA_VISIBLE_DEVICES: gpu,
        PYTHONUNBUFFERED: '1', HF_HOME: this.config.hfHome,
        HF_HUB_OFFLINE: this.config.modelOffline ? '1' : '0',
        HF_HUB_DISABLE_XET: process.env.HF_HUB_DISABLE_XET ?? '1',
        WORKER_MODE: this.config.workerMode, WORKER_INIT: JSON.stringify(engine),
        MAX_IMAGE_PIXELS: String(this.config.maxPixels),
        ENABLE_TEXT_RESTORATION: String(this.config.textRestoration),
      },
    });
    this.child = child;
    this.closing = new Promise(resolve => child.once('close', () => resolve()));
    const fail = (error: Error) => {
      if (this.child !== child) return;
      this.ready = false;
      this.readyReject?.(error);
      this.pending?.reject(error);
    };
    child.on('error', e => fail(new WorkerFailure('WORKER_START_FAILED', e.message)));
    child.on('exit', (code, signal) => fail(new WorkerFailure('WORKER_EXITED', `Worker exited (${code ?? signal})`)));
    for (const stream of [child.stdout, child.stderr]) stream?.on('data', data => this.log(String(data).slice(0, 8192)));
    const channel = child.stdio[3] as Readable;
    let lineBytes = 0;
    channel.on('data', (data: Buffer) => {
      lineBytes += data.length;
      if (lineBytes > 1024 * 1024) { fail(new WorkerFailure('WORKER_PROTOCOL_ERROR', 'Oversized worker event')); child.kill('SIGKILL'); }
      if (data.includes(10)) lineBytes = 0;
    });
    const lines = createInterface({ input: channel });
    lines.on('line', line => {
      if (this.child !== child) return;
      try {
        const event = JSON.parse(line) as WorkerEvent;
        if (event.protocol !== 1 || typeof event.type !== 'string') throw new Error('Invalid protocol');
        if (event.type === 'ready') { this.ready = true; this.lastError = null; this.info = event.info as Record<string, unknown>; this.readyResolve?.(); }
        else if (event.type === 'fatal') fail(new WorkerFailure('WORKER_INIT_FAILED', String(event.message)));
        else if (this.pending && event.job_id === this.pending.id) {
          if (event.type === 'completed') this.pending.resolve(event);
          else if (event.type === 'failed') this.pending.reject(new WorkerFailure(String(event.code ?? 'PROCESSING_FAILED'), String(event.message)));
          else this.pending.event(event);
        }
      } catch { fail(new WorkerFailure('WORKER_PROTOCOL_ERROR', 'Invalid JSON worker event')); child.kill('SIGKILL'); }
    });
    let timer: NodeJS.Timeout | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        this.readyResolve = resolve; this.readyReject = reject;
        timer = setTimeout(() => reject(new WorkerFailure('WORKER_INIT_TIMEOUT', 'Worker initialization timed out')), this.config.startupTimeoutMs);
      });
    } catch (error) { this.lastError = error instanceof WorkerFailure ? error.code : 'WORKER_INIT_FAILED'; await this.stop(); throw error; }
    finally { clearTimeout(timer); this.readyResolve = undefined; this.readyReject = undefined; }
  }

  async run(job: { id: string; input: string; output: string; manifest?: string; options: Options }, engine: EngineConfig | null,
    onEvent: (event: WorkerEvent) => void) {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        (async () => {
          if (!this.ready || (engine !== null && this.key !== JSON.stringify(engine))) {
            const next = engine ?? (this.key ? JSON.parse(this.key) as EngineConfig : null);
            if (!next) throw new WorkerFailure('WORKER_INIT_FAILED', 'Worker has no engine configuration');
            onEvent({ protocol: 1, type: 'stage', job_id: job.id, stage: 'loading_models' });
            await this.start(next);
          }
          return new Promise<WorkerEvent>((resolve, reject) => {
            this.pending = { id: job.id, resolve, reject, event: onEvent };
            this.child!.stdin!.write(JSON.stringify({ protocol: 1, type: 'process', ...job }) + '\n', error => {
              if (error) reject(new WorkerFailure('WORKER_WRITE_FAILED', error.message));
            });
          });
        })(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new WorkerFailure('TASK_TIMEOUT', 'Task timed out')), this.config.taskTimeoutMs);
        }),
      ]);
    } catch (error) {
      if (!(error instanceof WorkerFailure) || recycleWorker.has(error.code)) await this.stop();
      throw error;
    }
    finally { clearTimeout(timer); this.pending = undefined; }
  }

  async stop() {
    const child = this.child;
    this.ready = false;
    if (!child) return;
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
    await this.closing;
    clearTimeout(timer);
    if (this.child === child) this.child = undefined;
  }
}
