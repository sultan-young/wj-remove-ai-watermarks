import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import sharp from 'sharp';
import { buildApp } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { isPublicAddress, resolveTarget } from '../src/download.js';
import { parseOptions } from '../src/options.js';

const key = 'test-only-key-with-more-than-24-characters';
const auth = { authorization: `Bearer ${key}` };
const png = await sharp({ create: { width: 32, height: 24, channels: 3, background: '#123abc' } }).png().toBuffer();
async function setup(overrides: Partial<Config> = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'raiw-test-'));
  const config = { ...loadConfig({ API_KEY: key, WORKER_MODE: 'mock', LOG_LEVEL: 'silent', DATA_DIR: dir, PYTHON_BIN: process.env.PYTHON_BIN }),
    workerPath: path.resolve('test/fixture_worker.py'), restartDelayMs: 10, ...overrides };
  const built = await buildApp(config);
  await built.app.ready();
  const close = async () => { await built.app.close(); await rm(dir, { recursive: true, force: true }); };
  return { ...built, config, dir, close };
}
async function until<T>(fn: () => Promise<T> | T, done: (value: T) => boolean, max = 8000) {
  const start = Date.now();
  while (Date.now() - start < max) { const result = await fn(); if (done(result)) return result; await new Promise(r => setTimeout(r, 15)); }
  throw new Error('Timed out waiting for condition');
}
async function upload(app: Awaited<ReturnType<typeof setup>>['app'], options: unknown = {}, bytes = png, idempotencyKey?: string) {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(bytes)]), '../../input.png');
  form.append('options', JSON.stringify(options));
  const request = new Request('http://localhost/v1/jobs', { method: 'POST', body: form });
  return app.inject({ method: 'POST', url: '/v1/jobs', headers: { ...auth, 'content-type': request.headers.get('content-type')!,
    ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}) }, payload: Buffer.from(await request.arrayBuffer()) });
}
const final = (app: Awaited<ReturnType<typeof setup>>['app'], id: string) => until(async () =>
  (await app.inject({ url: `/v1/jobs/${id}`, headers: auth })).json(), j => ['succeeded', 'failed', 'cancelled'].includes(j.status));

test('upload -> persistent worker -> PNG download; auth, schema, idempotency and drain', async () => {
  const s = await setup();
  try {
    assert.equal((await s.app.inject('/health/live')).statusCode, 200);
    assert.equal((await s.app.inject('/v1/status')).statusCode, 401);
    await until(() => s.manager.slots[0]!.client.ready, Boolean);
    const cap = (await s.app.inject({ url: '/v1/capabilities', headers: auth })).json();
    assert.equal(cap.concurrency, 1); assert.equal(cap.worker_mode, 'mock'); assert.ok(cap.options_schema);
    const a = await upload(s.app, {}, png, 'same-request');
    assert.equal(a.statusCode, 202, a.body);
    const id = a.json().id;
    const duplicate = await upload(s.app, {}, png, 'same-request');
    assert.equal(duplicate.statusCode, 200); assert.equal(duplicate.json().id, id);
    assert.equal((await upload(s.app, { processing: { strength: 0.2 } }, png, 'same-request')).statusCode, 409);
    const result = await final(s.app, id); assert.equal(result.status, 'succeeded'); assert.equal(result.result.width, 32);
    assert.equal(result.effective.mock, true); assert.equal(result.result.downloaded_at, null);
    await s.app.inject({ method: 'POST', url: '/v1/drain', headers: auth, payload: { enabled: true } });
    assert.equal(s.manager.status().safe_to_stop, false);
    const image = await s.app.inject({ url: `/v1/jobs/${id}/result`, headers: auth });
    assert.equal(image.statusCode, 200); assert.equal(image.headers['x-worker-mode'], 'mock');
    assert.equal((await sharp(image.rawPayload).metadata()).height, 24);
    assert.equal(s.manager.status().safe_to_stop, false); // completed transfer is not confirmation of durable storage
    assert.equal((await s.app.inject({ method: 'POST', url: `/v1/jobs/${id}/ack`, headers: auth, payload: { sha256: 'a'.repeat(64) } })).statusCode, 409);
    await s.app.inject({ method: 'POST', url: `/v1/jobs/${id}/ack`, headers: auth, payload: { sha256: result.result.sha256 } });
    assert.equal(s.manager.status().safe_to_stop, true);
    assert.equal((await upload(s.app)).statusCode, 503);
    await s.app.inject({ method: 'POST', url: '/v1/drain', headers: auth, payload: { enabled: false } });
    assert.equal((await upload(s.app, { processing: { nonsense: 1 } })).statusCode, 400);
    assert.equal((await upload(s.app, {}, Buffer.from('not an image'))).statusCode, 422);
    assert.equal((await s.app.inject({ method: 'DELETE', url: `/v1/jobs/${id}`, headers: auth })).statusCode, 204);
    assert.equal((await s.app.inject({ url: `/v1/jobs/${id}`, headers: auth })).statusCode, 404);
  } finally { await s.close(); }
});

test('WORKER_CONCURRENCY=2 executes two tasks simultaneously; queue limit and cancel', async () => {
  const s = await setup({ concurrency: 2, maxQueue: 1, workerEnv: { MOCK_DELAY_MS: '500' } });
  try {
    await until(() => s.manager.slots.every(x => x.client.ready), Boolean);
    const a = (await upload(s.app)).json(), b = (await upload(s.app)).json();
    assert.equal(s.manager.status().running, 2);
    const c = await upload(s.app); assert.equal(c.statusCode, 202, c.body);
    assert.equal((await upload(s.app)).statusCode, 429);
    assert.equal((await s.app.inject({ method: 'POST', url: `/v1/jobs/${c.json().id}/cancel`, headers: auth })).json().status, 'cancelled');
    assert.equal((await final(s.app, a.id)).status, 'succeeded');
    assert.equal((await final(s.app, b.id)).status, 'succeeded');
    const after = (await upload(s.app)).json(); assert.equal((await final(s.app, after.id)).status, 'succeeded');
    assert.equal(s.manager.slots[0]!.client.info.mode, 'mock');
  } finally { await s.close(); }
});

test('worker crash fails current task and recovers queued task; running cancellation is isolated', async () => {
  const s = await setup();
  try {
    await until(() => s.manager.slots[0]!.client.ready, Boolean);
    const broken = (await upload(s.app, { processing: { seed: 99 } })).json();
    const next = (await upload(s.app)).json();
    assert.equal((await final(s.app, broken.id)).status, 'failed');
    assert.equal((await final(s.app, next.id)).status, 'succeeded');
    const running = (await upload(s.app, { processing: { seed: 98 } })).json();
    await until(() => s.manager.get(running.id).status, x => x === 'running');
    await s.app.inject({ method: 'POST', url: `/v1/jobs/${running.id}/cancel`, headers: auth });
    assert.equal((await final(s.app, running.id)).status, 'cancelled');
    const last = (await upload(s.app)).json(); assert.equal((await final(s.app, last.id)).status, 'succeeded');
  } finally { await s.close(); }
});

test('business failure keeps the worker; timeout recycles it', async () => {
  const s = await setup({ taskTimeoutMs: 500 });
  try {
    await until(() => s.manager.slots[0]!.client.ready, Boolean);
    const pid = s.manager.slots[0]!.client.child!.pid;
    const failed = (await upload(s.app, { processing: { seed: 96 } })).json();
    const failure = await final(s.app, failed.id);
    assert.equal(failure.status, 'failed');
    assert.equal(failure.error.code, 'PROCESSING_FAILED');
    assert.equal(s.manager.slots[0]!.client.ready, true);
    assert.equal(s.manager.slots[0]!.client.child!.pid, pid);
    const timedOut = (await upload(s.app, { processing: { seed: 98 } })).json();
    assert.equal((await final(s.app, timedOut.id)).error.code, 'TASK_TIMEOUT');
    await until(() => s.manager.slots[0]!.client.ready && s.manager.slots[0]!.client.child?.pid !== pid, Boolean);
  } finally { await s.close(); }
});

test('worker errors, timeout and malformed output never publish a successful result', async () => {
  const s = await setup({ taskTimeoutMs: 500 });
  try {
    await until(() => s.manager.slots[0]!.client.ready, Boolean);
    for (const seed of [96, 97, 98]) {
      const a = await upload(s.app, { processing: { seed } }); assert.equal(a.statusCode, 202, a.body);
      const job = await final(s.app, a.json().id); assert.equal(job.status, 'failed');
      if (seed === 98) assert.equal(job.error.code, 'TASK_TIMEOUT');
      assert.equal((await s.app.inject({ url: `/v1/jobs/${job.id}/result`, headers: auth })).statusCode, 409);
    }
  } finally { await s.close(); }
});

test('cancelling one concurrent worker does not terminate the other worker', async () => {
  const s = await setup({ concurrency: 2, workerEnv: { MOCK_DELAY_MS: '250' } });
  try {
    await until(() => s.manager.slots.every(x => x.client.ready), Boolean);
    const a = (await upload(s.app, { processing: { seed: 98 } })).json();
    const b = (await upload(s.app)).json();
    assert.equal(s.manager.status().running, 2);
    await s.app.inject({ method: 'POST', url: `/v1/jobs/${a.id}/cancel`, headers: auth });
    assert.equal((await final(s.app, a.id)).status, 'cancelled');
    assert.equal((await final(s.app, b.id)).status, 'succeeded');
  } finally { await s.close(); }
});

test('drain blocks new work but finishes accepted queued tasks; worker PID is reused', async () => {
  const s = await setup({ workerEnv: { MOCK_DELAY_MS: '150' } });
  try {
    await until(() => s.manager.slots[0]!.client.ready, Boolean);
    const pid = s.manager.slots[0]!.client.child!.pid;
    const a = (await upload(s.app)).json();
    const b = (await upload(s.app)).json();
    await s.app.inject({ method: 'POST', url: '/v1/drain', headers: auth, payload: { enabled: true } });
    assert.equal((await final(s.app, a.id)).status, 'succeeded');
    assert.equal((await final(s.app, b.id)).status, 'succeeded');
    assert.equal(s.manager.slots[0]!.client.child!.pid, pid);
    assert.equal(s.manager.status().uncollected_results, 2);
    assert.equal((await upload(s.app)).statusCode, 503);
  } finally { await s.close(); }
});

test('URL redirects recheck destination port; multipart rejects conflicting sources and accepts a text manifest', async () => {
  const origin = createServer((_request, response) => { response.writeHead(302, { location: 'http://127.0.0.1:1/private' }); response.end(); });
  await new Promise<void>(resolve => origin.listen(0, '127.0.0.1', resolve));
  const port = (origin.address() as any).port;
  const s = await setup({ urlAllowPrivate: true, urlPorts: [port] });
  try {
    const result = await s.app.inject({ method: 'POST', url: '/v1/jobs', headers: auth, payload: { url: `http://127.0.0.1:${port}` } });
    assert.equal(result.statusCode, 400); assert.equal(result.json().error.code, 'URL_PORT_BLOCKED');
    const form = new FormData(); form.append('file', new Blob([new Uint8Array(png)]), 'test.png');
    form.append('url', 'https://example.com/test.png');
    const request = new Request('http://localhost', { method: 'POST', body: form });
    const rejected = await s.app.inject({ method: 'POST', url: '/v1/jobs', headers: { ...auth, 'content-type': request.headers.get('content-type')! }, payload: Buffer.from(await request.arrayBuffer()) });
    assert.equal(rejected.statusCode, 400);
    const manifest = new FormData(); manifest.append('file', new Blob([new Uint8Array(png)]), 'test.png');
    manifest.append('text_manifest', '{"verified":true,"lines":[{"box":[0,0,1,1],"angle":12}]}');
    const manifestRequest = new Request('http://localhost', { method: 'POST', body: manifest });
    const accepted = await s.app.inject({ method: 'POST', url: '/v1/jobs', headers: { ...auth, 'content-type': manifestRequest.headers.get('content-type')! }, payload: Buffer.from(await manifestRequest.arrayBuffer()) });
    assert.equal(accepted.statusCode, 202, accepted.body);
  } finally { await s.close(); origin.closeAllConnections(); await new Promise<void>(resolve => origin.close(() => resolve())); }
});

test('engine-level configuration change restarts worker and records selected configuration', async () => {
  const s = await setup();
  try {
    await until(() => s.manager.slots[0]!.client.ready, Boolean);
    const pid = s.manager.slots[0]!.client.child!.pid;
    const a = (await upload(s.app, { processing: { controlnet_conditioning_scale: 1.2 } })).json();
    assert.equal((await final(s.app, a.id)).status, 'succeeded');
    assert.notEqual(s.manager.slots[0]!.client.child!.pid, pid);
    assert.equal((s.manager.slots[0]!.client.info.engine as any).controlnet_conditioning_scale, 1.2);
  } finally { await s.close(); }
});

test('result TTL expires files; restart intentionally loses task records', async () => {
  const s = await setup({ retentionMs: 100 });
  const a = (await upload(s.app)).json();
  assert.equal((await final(s.app, a.id)).status, 'succeeded');
  await new Promise(r => setTimeout(r, 110)); await s.manager.cleanup();
  assert.equal((await s.app.inject({ url: `/v1/jobs/${a.id}/result`, headers: auth })).statusCode, 410);
  await s.app.close();
  const second = await buildApp(s.config);
  try { assert.equal((await second.app.inject({ url: `/v1/jobs/${a.id}`, headers: auth })).statusCode, 404); }
  finally { await second.app.close(); await rm(s.dir, { recursive: true, force: true }); }
});

test('upload limits, pixel limits, manifests and invalid options reject before processing', async () => {
  const s = await setup({ maxBytes: png.length - 1 });
  try { assert.equal((await upload(s.app)).statusCode, 413); assert.equal(s.manager.jobs.size, 0); }
  finally { await s.close(); }
  const t = await setup({ maxPixels: 100 });
  try { assert.equal((await upload(t.app)).statusCode, 422); }
  finally { await t.close(); }
  const config = loadConfig({ API_KEY: key });
  assert.equal(parseOptions({ processing: { tile_overlap: 1024 } }, config).processing.tile_overlap, 1024);
  assert.throws(() => parseOptions({ processing: { mark: 'loose' } }, config));
  assert.equal(parseOptions({ processing: { sensitivity: 'strict' } }, config).processing.sensitivity, 'strict');
  assert.equal(parseOptions({ processing: { mark: 'gemini', detect: false } }, config).processing.detect, false);
  assert.equal(parseOptions({}, config).processing.force, false);
  assert.equal(parseOptions({}, config).processing.seed, null);
  assert.equal(parseOptions({}, config).processing.adaptive_polish, null);
  assert.equal(parseOptions({}, config).processing.pipeline, 'qwen-zimage');
  assert.throws(() => parseOptions({ processing: { mode: 'all', mark: 'gemini' } }, config));
  const restricted = loadConfig({ API_KEY: key, ENABLED_PIPELINES: 'sdxl-zimage' });
  assert.throws(() => parseOptions({}, restricted));
  assert.throws(() => loadConfig({ API_KEY: key, WORKER_CONCURRENCY: '0' }));
  assert.equal(loadConfig({ API_KEY: key, WORKER_CONCURRENCY: '2' }).concurrency, 2);
});

test('failed worker initialization reports not-ready; queued tasks have a bounded wait', async () => {
  const s = await setup({ python: '/nonexistent/python', queueTimeoutMs: 20, restartDelayMs: 1000 });
  try {
    await until(() => s.manager.slots[0]!.client.lastError, Boolean);
    assert.equal((await s.app.inject({ url: '/health/ready', headers: auth })).statusCode, 503);
    const task = (await upload(s.app)).json();
    await new Promise(resolve => setTimeout(resolve, 30));
    await s.manager.cleanup();
    assert.equal(s.manager.get(task.id).status, 'failed');
    assert.equal(s.manager.get(task.id).error?.code, 'QUEUE_TIMEOUT');
  } finally { await s.close(); }
});

test('URL download, redirects, chunked limit, bad status, timeout and private-address protection', async () => {
  const origin = createServer((req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { location: '/image' }); res.end(); }
    else if (req.url === '/loop') { res.writeHead(302, { location: '/loop' }); res.end(); }
    else if (req.url === '/missing') { res.writeHead(404); res.end(); }
    else if (req.url === '/slow') { /* client timeout closes this connection */ }
    else if (req.url === '/large') { res.writeHead(200); res.write(Buffer.alloc(1024)); res.end(Buffer.alloc(1024)); }
    else { res.writeHead(200, { 'content-type': 'image/png' }); res.end(png); }
  });
  await new Promise<void>(resolve => origin.listen(0, '127.0.0.1', resolve));
  const port = (origin.address() as any).port;
  const base = `http://127.0.0.1:${port}`;
  const s = await setup({ urlAllowPrivate: true, urlPorts: [port], urlTimeoutMs: 300, maxBytes: 1024 });
  try {
    const submit = (route: string) => s.app.inject({ method: 'POST', url: '/v1/jobs', headers: auth, payload: { url: base + route } });
    const image = await submit('/redirect'); assert.equal(image.statusCode, 202, image.body);
    assert.equal((await final(s.app, image.json().id)).status, 'succeeded');
    assert.equal((await submit('/loop')).statusCode, 400);
    assert.equal((await submit('/missing')).statusCode, 502);
    assert.equal((await submit('/large')).statusCode, 413);
    assert.equal((await submit('/slow')).statusCode, 502);
    assert.equal(s.manager.intakes, 0);
    const leftovers = await readdir(s.manager.runDir); assert.equal(leftovers.length, 2); // owner + successful job only
    const blocked = { ...s.config, urlAllowPrivate: false };
    await assert.rejects(resolveTarget(new URL(base), blocked), /public addresses/);
    await assert.rejects(resolveTarget(new URL('file:///etc/passwd'), blocked), /HTTP/);
    await assert.rejects(resolveTarget(new URL('http://user:pass@example.com'), blocked), /HTTP/);
    await assert.rejects(resolveTarget(new URL('https://example.com:444'), blocked), /port/);
    for (const ip of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '::1', '::ffff:127.0.0.1', 'fc00::1', '0.0.0.0']) assert.equal(isPublicAddress(ip), false, ip);
    assert.equal(isPublicAddress('8.8.8.8'), true);
  } finally { await s.close(); origin.closeAllConnections(); await new Promise<void>(resolve => origin.close(() => resolve())); }
});
