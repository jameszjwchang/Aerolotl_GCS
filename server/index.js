import { createGcs, localAddresses } from './app.js';

const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');
const gcs = createGcs();
let stopping = false;
async function stop(exitCode) {
  if (stopping) return;
  stopping = true;
  process.exitCode = exitCode;
  await gcs.close();
}
gcs.server.on('error', error => { console.error(`Dashboard receiver: ${error.message}`); void stop(1); });
gcs.flightReceiver.on('error', error => { console.error(`Flight UDP receiver: ${error.message}`); void stop(1); });
gcs.server.listen(port, '0.0.0.0', () => {
  if (stopping) return;
  gcs.flightReceiver.bind(port, '0.0.0.0', () => {
    console.log(`Aerolotl GCS: http://localhost:${port}`);
    for (const address of localAddresses(port)) {
      console.log(`Flight computer UDP: ${new URL(address).host}`);
      console.log(`Aerolotl Sender (iPhone test): ${address.replace('http:', 'ws:')}/ws/ingest`);
      console.log(`Sensor Logger HTTP Push: ${address}/api/telemetry`);
    }
    console.log('Keep this process running. Stop with Ctrl+C.');
  });
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void stop(0); });
