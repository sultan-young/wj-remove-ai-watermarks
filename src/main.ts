import { loadConfig } from './config.js';
import { buildApp } from './app.js';

const config = loadConfig();
const { app } = await buildApp(config);
let closing = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, async () => {
  if (closing) return; closing = true;
  const deadline = setTimeout(() => process.exit(1), 10000);
  try { await app.close(); clearTimeout(deadline); process.exit(0); }
  catch { process.exit(1); }
});
await app.listen({ host: config.host, port: config.port });
app.log.info({ concurrency: config.concurrency, devices: config.devices, mode: config.workerMode }, 'GPU image service started');
