import Fastify, { LogController } from 'fastify';
import multipart from '@fastify/multipart';
import { z } from 'zod';
import { createHash, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, writeFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Manager, createRunDir, type Job } from './manager.js';
import { upstreamPipeline, type Config } from './config.js';
import { requestOptionsSchema, parseOptions } from './options.js';
import { ServiceError } from './errors.js';
import { saveLimited, validateImage } from './images.js';
import { downloadImage } from './download.js';

export async function buildApp(config: Config) {
  const app = Fastify({ logger: { level: config.logLevel, redact: ['req.headers.authorization', 'req.body.url'] },
    logController: new LogController({ disableRequestLogging: true }), bodyLimit: 512 * 1024, requestTimeout: config.urlTimeoutMs + 120000 });
  await app.register(multipart, { limits: { files: 1, fields: 3, parts: 4, fileSize: config.maxBytes, fieldSize: 300 * 1024 } });
  const manager = new Manager(config, await createRunDir(config), message => app.log.info({ message }, 'worker'));

  app.addHook('onRequest', async (request, reply) => {
    if (request.url.split('?')[0] === '/health/live') return;
    const actual = Buffer.from(request.headers.authorization ?? '');
    const expected = Buffer.from(`Bearer ${config.key}`);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Bearer token required' } });
  });
  app.setErrorHandler((error, _request, reply) => {
    const err = error as Error & { statusCode?: number; code?: string };
    const status = error instanceof ServiceError ? error.status : err.statusCode && err.statusCode < 500 ? err.statusCode : error instanceof z.ZodError ? 400 : 500;
    if (status >= 500) app.log.error({ code: err.code, name: err.name }, 'Request failed');
    reply.code(status).send({ error: { code: err.code ?? (status === 400 ? 'INVALID_REQUEST' : 'INTERNAL_ERROR'),
      message: status < 500 ? err.message : error instanceof ServiceError ? err.message : 'Internal server error' } });
  });

  app.get('/health/live', async () => ({ status: 'alive', version: '1.0.0' }));
  app.get('/health/ready', async (_request, reply) => {
    const ready = !manager.draining && manager.slots.some(slot => slot.client.ready);
    return reply.code(ready ? 200 : 503).send({ ready, draining: manager.draining, worker_mode: config.workerMode });
  });
  app.get('/v1/capabilities', async () => {
    const probed = manager.slots.map(slot => slot.client.info).find(info => typeof info.visible_available === 'boolean');
    const visibleAvailable = Boolean(probed && probed.visible_available !== false);
    const visibleBackends = Array.isArray(probed?.visible_backends) ? probed.visible_backends : ['auto', 'cv2'];
    const visibleMarks = Array.isArray(probed?.visible_marks) ? probed.visible_marks : ['auto'];
    return {
    service_version: '1.0.0', library_version: '0.47.1', protocol_version: 1, worker_mode: config.workerMode,
    default_pipeline: upstreamPipeline, enabled_pipelines: config.enabled,
    concurrency: config.concurrency, gpu_devices: config.devices,
    input: { methods: ['multipart', 'url'], formats: ['png', 'jpeg', 'webp'], max_bytes: config.maxBytes, max_pixels: config.maxPixels,
      url_allowed_ports: config.urlPorts, url_private_addresses_allowed: config.urlAllowPrivate },
    modes: visibleAvailable ? ['all', 'visible', 'invisible', 'metadata'] : ['invisible', 'metadata'],
    visible_backends: visibleBackends,
    visible_marks: visibleMarks,
    output: { format: 'png', retains_input_dimensions: true, ttl_seconds: config.retentionMs / 1000 },
    limits_are_service_limits: true,
    options_schema: z.toJSONSchema(requestOptionsSchema, { target: 'draft-7', io: 'input' }),
    workers: manager.status().workers,
    verification: 'Processing success is not a provider watermark-verification verdict',
    };
  });
  app.get('/v1/status', async () => manager.status());
  app.post('/v1/drain', async request => {
    const body = z.object({ enabled: z.boolean() }).strict().parse(request.body);
    manager.draining = body.enabled; return manager.status();
  });

  app.post('/v1/jobs', async (request, reply) => {
    const release = manager.beginIntake();
    let dir: string | undefined; let retained = false;
    try {
      const key = request.headers['idempotency-key'];
      if (key !== undefined && (typeof key !== 'string' || !/^[\x21-\x7e]{1,128}$/.test(key)))
        throw new ServiceError(400, 'INVALID_IDEMPOTENCY_KEY', 'Key must contain 1-128 printable ASCII characters');
      const created = await manager.newDir(); dir = created.dir;
      let input = path.join(dir, 'input.image');
      let rawOptions: unknown = {}; let url: string | undefined; let manifest: unknown; let hasFile = false;
      if (request.isMultipart()) {
        const seen = new Set<string>();
        for await (const part of request.parts()) {
          if (seen.has(part.fieldname)) throw new ServiceError(400, 'DUPLICATE_FIELD', 'Duplicate multipart field');
          seen.add(part.fieldname);
          if (part.type === 'file') {
            if (part.fieldname !== 'file') throw new ServiceError(400, 'INVALID_FIELD', 'File field must be named file');
            await saveLimited(part.file, input, config.maxBytes);
            if (part.file.truncated) throw new ServiceError(413, 'IMAGE_TOO_LARGE', 'Image exceeds upload limit');
            hasFile = true;
          } else {
            if (part.valueTruncated) throw new ServiceError(413, 'FIELD_TOO_LARGE', 'Field exceeds size limit');
            const value = String(part.value);
            if (part.fieldname === 'options') { if (value.length > 65536) throw new ServiceError(413, 'OPTIONS_TOO_LARGE', 'Options too large'); rawOptions = JSON.parse(value); }
            else if (part.fieldname === 'url') url = value;
            else if (part.fieldname === 'text_manifest') manifest = JSON.parse(value);
            else throw new ServiceError(400, 'INVALID_FIELD', 'Unknown multipart field');
          }
        }
      } else {
        const body = z.object({ url: z.string().min(1).max(8192), options: z.unknown().optional(), text_manifest: z.unknown().optional() }).strict().parse(request.body);
        url = body.url; rawOptions = body.options ?? {}; manifest = body.text_manifest;
      }
      if (hasFile === (url !== undefined)) throw new ServiceError(400, 'INVALID_SOURCE', 'Provide exactly one file or URL');
      let options;
      try { options = parseOptions(rawOptions, config); }
      catch (error) { throw new ServiceError(400, 'INVALID_OPTIONS', error instanceof Error ? error.message : 'Invalid options'); }
      if (manifest !== undefined && (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)))
        throw new ServiceError(400, 'INVALID_MANIFEST', 'Manifest must be an object');
      if (url !== undefined) { if (url.length > 8192) throw new ServiceError(400, 'INVALID_URL', 'URL too long'); await downloadImage(url, input, config); }
      const inputInfo = await validateImage(input, config.maxPixels);
      // Give the upstream file-based provenance readers a truthful extension without re-encoding.
      const typedInput = path.join(dir, `input.${inputInfo.format === 'jpeg' ? 'jpg' : inputInfo.format}`);
      const { rename } = await import('node:fs/promises');
      await rename(input, typedInput); input = typedInput;
      let manifestPath: string | undefined;
      if (manifest !== undefined) { manifestPath = path.join(dir, 'text-manifest.json'); await writeFile(manifestPath, JSON.stringify(manifest), { mode: 0o600 }); }
      const fingerprint = createHash('sha256').update(await readFile(input)).update(JSON.stringify(options)).update(JSON.stringify(manifest ?? null)).digest('hex');
      const job: Job = { id: created.id, dir, input, output: path.join(dir, 'result.png'), manifest: manifestPath,
        status: 'queued', stage: 'queued', options, source: hasFile ? 'upload' : 'url', created: Date.now(), inputInfo,
        expired: false, downloads: 0, cancelRequested: false };
      const result = manager.enqueue(job, key, fingerprint);
      retained = !result.reused;
      return reply.code(result.reused ? 200 : 202).send({ ...manager.view(result.job), reused: result.reused });
    } catch (error) {
      if (error instanceof SyntaxError) throw new ServiceError(400, 'INVALID_JSON', 'Invalid JSON in request fields');
      throw error;
    } finally {
      release();
      if (dir && !retained) await rm(dir, { recursive: true, force: true });
    }
  });
  const idFrom = (params: unknown) => z.object({ id: z.string().uuid() }).parse(params).id;
  app.get('/v1/jobs', async () => ({ jobs: [...manager.jobs.values()].map(job => manager.view(job)) }));
  app.get('/v1/jobs/:id', async request => manager.view(manager.get(idFrom(request.params))));
  app.post('/v1/jobs/:id/cancel', async request => manager.cancel(idFrom(request.params)));
  app.post('/v1/jobs/:id/ack', async request => {
    const job = manager.get(idFrom(request.params));
    const body = z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(request.body);
    if (job.expired) throw new ServiceError(410, 'RESULT_EXPIRED', 'Result has expired');
    if (job.status !== 'succeeded' || body.sha256 !== job.result?.sha256)
      throw new ServiceError(409, 'ACK_MISMATCH', 'Result is not ready or SHA-256 differs');
    job.acknowledgedAt ??= Date.now(); return manager.view(job);
  });
  app.delete('/v1/jobs/:id', async (request, reply) => { await manager.delete(idFrom(request.params)); return reply.code(204).send(); });
  app.get('/v1/jobs/:id/result', async (request, reply) => {
    const job = manager.get(idFrom(request.params));
    if (job.expired) throw new ServiceError(410, 'RESULT_EXPIRED', 'Result has expired');
    if (job.status !== 'succeeded') throw new ServiceError(409, 'RESULT_NOT_READY', 'Task has no successful result');
    job.downloads++;
    let finished = false;
    const release = () => { if (!finished) { finished = true; job.downloads--; } };
    reply.raw.once('finish', () => { job.downloadedAt = Date.now(); release(); });
    reply.raw.once('close', release);
    try {
      const size = (await stat(job.output)).size;
      return reply.type('image/png').header('Content-Length', size).header('Cache-Control', 'no-store')
        .header('Content-Disposition', `attachment; filename="${job.id}.png"`).header('X-Worker-Mode', config.workerMode)
        .send(createReadStream(job.output));
    } catch { release(); throw new ServiceError(410, 'RESULT_MISSING', 'Result file is unavailable'); }
  });
  app.addHook('onClose', async () => manager.close());
  manager.start();
  return { app, manager };
}
