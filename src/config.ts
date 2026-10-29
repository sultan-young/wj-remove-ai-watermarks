import 'dotenv/config';
import path from 'node:path';
import { z } from 'zod';

const integer = (value: string | undefined, fallback: number, min = 1, max = 2 ** 31 - 1) =>
  z.coerce.number().int().min(min).max(max).parse(value ?? fallback);
const flag = (value: string | undefined, fallback: boolean) => {
  if (value === undefined) return fallback;
  if (!['true', 'false', '1', '0'].includes(value)) throw new Error(`Invalid boolean: ${value}`);
  return value === 'true' || value === '1';
};
export const profiles = ['qwen-zimage', 'sdxl-zimage', 'chroma-zimage', 'auto'] as const;
/** Omitted `pipeline` uses the upstream default. It is never replaced by another profile. */
export const upstreamPipeline = 'qwen-zimage' as const;
export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const key = z.string().min(24).parse(env.API_KEY);
  if (key.startsWith('replace-this-')) throw new Error('Replace the example API_KEY before starting');
  const enabled = (env.ENABLED_PIPELINES ?? profiles.join(',')).split(',').map(x => z.enum(profiles).parse(x.trim()));
  const devices = (env.GPU_DEVICES ?? '0').split(',').map(x => x.trim());
  if (devices.some(x => !/^(\d+|GPU-[\w-]+|MIG-[\w/-]+)$/.test(x))) throw new Error('Invalid GPU_DEVICES');
  return {
    key, enabled, devices,
    host: env.HOST ?? '0.0.0.0', port: integer(env.PORT, 8000, 1, 65535),
    concurrency: integer(env.WORKER_CONCURRENCY, 1, 1, 16),
    maxQueue: integer(env.MAX_QUEUE_SIZE, 32, 1, 10000),
    maxRecords: integer(env.MAX_TASK_RECORDS, 2000, 1, 100000),
    maxBytes: integer(env.MAX_IMAGE_BYTES, 32 * 1024 * 1024),
    maxPixels: integer(env.MAX_IMAGE_PIXELS, 16777216),
    urlTimeoutMs: integer(env.URL_TIMEOUT_MS, 60000),
    urlMaxRedirects: integer(env.URL_MAX_REDIRECTS, 3, 0, 10),
    urlAllowPrivate: flag(env.URL_ALLOW_PRIVATE, false),
    urlPorts: (env.URL_ALLOWED_PORTS ?? '80,443').split(',').map(x => integer(x.trim(), 443, 1, 65535)),
    retentionMs: integer(env.RESULT_TTL_SECONDS, 3600) * 1000,
    taskTimeoutMs: integer(env.TASK_TIMEOUT_SECONDS, 1200) * 1000,
    queueTimeoutMs: integer(env.QUEUE_TIMEOUT_SECONDS, 1800) * 1000,
    startupTimeoutMs: integer(env.WORKER_START_TIMEOUT_SECONDS, 600) * 1000,
    restartDelayMs: integer(env.WORKER_RESTART_DELAY_MS, 3000),
    dataDir: path.resolve(env.DATA_DIR ?? './data'),
    python: env.PYTHON_BIN ?? 'python3',
    workerPath: path.resolve(env.PYTHON_WORKER ?? './python/worker.py'),
    workerMode: z.enum(['real', 'mock']).parse(env.WORKER_MODE ?? 'real'),
    hfHome: path.resolve(env.HF_HOME ?? './model-cache'),
    modelOffline: flag(env.MODEL_OFFLINE, true),
    logLevel: z.enum(['silent', 'fatal', 'error', 'warn', 'info', 'debug', 'trace']).parse(env.LOG_LEVEL ?? 'info'),
    workerEnv: {} as NodeJS.ProcessEnv,
  };
}
export type Config = ReturnType<typeof loadConfig>;
