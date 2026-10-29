import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { GpuClient } from './client.mjs';

const client = new GpuClient(process.env.GPU_BASE_URL || 'http://127.0.0.1:8000', process.env.API_KEY);
const source = process.argv[2];
if (!source) throw new Error('Usage: npm run smoke -- /path/input.png [output.png] OR npm run smoke -- https://example.com/input.png');
const ready = await client.request('/health/ready');
console.log('Ready:', await ready.json());
const options = { processing: { pipeline: 'sdxl-zimage', max_resolution: 0, seed: 0 } };
const key = randomUUID();
console.log('Request key:', key, '(reuse it if a submission network error occurs)');
const task = /^https?:\/\//.test(source) ? await client.submitUrl(source, options, key) : await client.submitFile(source, options, key);
console.log('Task:', task.id);
let stage;
const done = await client.wait(task.id, { onStatus(job) {
  if (stage !== job.stage) { stage = job.stage; console.log(job.status, stage); }
}});
console.log('Result:', await client.downloadAndAck(done, process.argv[3] || `output-${task.id}.png`));
console.log('Elapsed:', done.elapsed_seconds, 'seconds; effective:', done.effective);
console.log('Mode:', done.worker_mode, '(mock means no watermark removal)');
