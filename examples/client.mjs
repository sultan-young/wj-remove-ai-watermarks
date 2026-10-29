/** Node.js 24 client. Import into your own backend, never expose API_KEY to browsers. */
import { randomUUID, createHash } from 'node:crypto';
import { readFile, rename, rm, mkdir } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';

export class GpuClient {
  constructor(baseUrl, apiKey, timeoutMs = 120000) {
    this.baseUrl = baseUrl.replace(/\/$/, ''); this.apiKey = apiKey; this.timeoutMs = timeoutMs;
  }
  async request(route, options = {}) {
    const response = await fetch(this.baseUrl + route, {
      ...options, signal: options.signal ?? AbortSignal.timeout(this.timeoutMs),
      headers: { Authorization: `Bearer ${this.apiKey}`, ...options.headers },
    });
    if (!response.ok) {
      const detail = await response.text();
      const error = new Error(`GPU HTTP ${response.status}: ${detail}`);
      error.status = response.status; throw error;
    }
    return response;
  }
  async submitFile(filePath, options = {}, idempotencyKey = randomUUID()) {
    const form = new FormData();
    form.append('file', new Blob([await readFile(filePath)]), path.basename(filePath));
    form.append('options', JSON.stringify(options));
    return (await this.request('/v1/jobs', { method: 'POST', headers: { 'Idempotency-Key': idempotencyKey }, body: form })).json();
  }
  async submitUrl(url, options = {}, idempotencyKey = randomUUID()) {
    return (await this.request('/v1/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey }, body: JSON.stringify({ url, options }) })).json();
  }
  async wait(id, { timeoutMs = 30 * 60 * 1000, intervalMs = 1000, onStatus = () => {} } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const job = await (await this.request(`/v1/jobs/${id}`)).json();
      onStatus(job);
      if (job.status === 'succeeded') return job;
      if (job.status === 'failed' || job.status === 'cancelled') throw new Error(`Task ${job.status}: ${JSON.stringify(job.error)}`);
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
    throw new Error('Polling timeout (server task was not cancelled)');
  }
  async downloadAndAck(job, destination) {
    const response = await this.request(`/v1/jobs/${job.id}/result`);
    await mkdir(path.dirname(destination), { recursive: true });
    const temp = destination + '.' + randomUUID() + '.tmp';
    const hash = createHash('sha256');
    try {
      await pipeline(Readable.fromWeb(response.body), new Transform({ transform(chunk, _encoding, callback) {
        hash.update(chunk); callback(null, chunk);
      }}), createWriteStream(temp, { flags: 'wx' }));
      const sha256 = hash.digest('hex');
      if (sha256 !== job.result.sha256) throw new Error('Downloaded SHA-256 does not match');
      await rename(temp, destination);
      // Your backend may perform its durable/object-store save here before acknowledging.
      await this.request(`/v1/jobs/${job.id}/ack`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sha256 }) });
      return destination;
    } finally { await rm(temp, { force: true }); }
  }
}
