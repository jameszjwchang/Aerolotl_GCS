import { createGcs, localAddresses } from './app.js';

const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');
const gcs = createGcs();
gcs.server.on('error', error => { console.error(`Could not start GCS: ${error.message}`); process.exitCode = 1; });
gcs.server.listen(port, '0.0.0.0', () => {
  console.log(`Aerolotl GCS: http://localhost:${port}`);
  for (const address of localAddresses(port)) {
    console.log(`Aerolotl Sender: ${address.replace('http:', 'ws:')}/ws/ingest`);
    console.log(`Sensor Logger HTTP Push: ${address}/api/telemetry`);
  }
  console.log('Keep this process running. Stop with Ctrl+C.');
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await gcs.close(); process.exit(); });
