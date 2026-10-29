import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
// JavaScript client is intentionally shipped without a build step.
import { GpuClient } from '../examples/client.mjs';

test('shipped JS client works over real HTTP: submit file + URL, download, hash check and ack', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'raiw-client-'));
  const key = 'client-test-key-longer-than-twenty-four';
  const config = loadConfig({ API_KEY: key, WORKER_MODE: 'mock', LOG_LEVEL: 'silent', DATA_DIR: root, PYTHON_BIN: process.env.PYTHON_BIN });
  const { app } = await buildApp(config);
  try {
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    const client = new GpuClient(address, key, 10000);
    const input = path.join(root, 'input.jpg'), output = path.join(root, 'output.png');
    // EXIF rotation must be applied: raw 40x24 orientation=6 -> displayed/output 24x40.
    await sharp({ create: { width: 40, height: 24, channels: 3, background: '#ab1234' } })
      .withMetadata({ orientation: 6 }).jpeg().toFile(input);
    const task = await client.submitFile(input, {}, 'client-retry-key');
    const same = await client.submitFile(input, {}, 'client-retry-key');
    assert.equal(same.id, task.id);
    const job = await client.wait(task.id, { timeoutMs: 10000, intervalMs: 20 });
    await client.downloadAndAck(job, output);
    const meta = await sharp(await readFile(output)).metadata();
    assert.equal(meta.width, 24); assert.equal(meta.height, 40);
    const status = await (await client.request(`/v1/jobs/${task.id}`)).json();
    assert.ok(status.result.acknowledged_at);
    // URL through real client: blocked private destination must be reported, not silently accepted.
    await assert.rejects(client.submitUrl('http://127.0.0.1/a.png'), /400/);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});
