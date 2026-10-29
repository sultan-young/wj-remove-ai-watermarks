import { loadConfig } from './config.js';
import { buildApp } from './app.js';

const config = loadConfig();
const { app, manager } = await buildApp(config);
let closing = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, async () => {
  if (closing) return; closing = true;
  const deadline = setTimeout(() => process.exit(1), 10000);
  try { await app.close(); clearTimeout(deadline); process.exit(0); }
  catch { process.exit(1); }
});
await app.listen({ host: config.host, port: config.port });
app.log.info({ concurrency: config.concurrency, devices: config.devices, mode: config.workerMode }, 'GPU image service started');

const deadline = Date.now() + config.startupTimeoutMs;
while (Date.now() < deadline) {
  if (manager.slots.some(slot => slot.client.ready)) {
    app.log.info({ workers: manager.slots.filter(slot => slot.client.ready).length }, 'Workers ready');
    break;
  }
  await new Promise(resolve => setTimeout(resolve, 1000));
}
if (!manager.slots.some(slot => slot.client.ready)) {
  app.log.error({ timeout_ms: config.startupTimeoutMs }, 'No worker became ready before startup timeout');
  process.exit(1);
}
