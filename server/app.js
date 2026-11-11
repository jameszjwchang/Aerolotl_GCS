import express from 'express';
import { createSocket } from 'node:dgram';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { parseSensorLogger, InputError } from './sensor-logger.js';
import { MAX_FLIGHT_PACKET_BYTES, parseAerolotlPacket } from './aerolotl-packet.js';
import { TelemetryStore } from '../public/telemetry.js';

export function localAddresses(port) {
  return [...new Set(Object.values(networkInterfaces()).flat().filter(info =>
    info && info.family === 'IPv4' && !info.internal).map(info => `http://${info.address}:${port}`))];
}

export function createGcs({ clock = Date.now } = {}) {
  const app = express();
  const server = createServer(app);
  const store = new TelemetryStore();
  const wss = new WebSocketServer({ noServer: true });
  const senders = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  const flightReceiver = createSocket('udp4');
  app.disable('x-powered-by');
  app.use(express.json({ limit: '4mb' }));
  app.get('/api/config', (_req, res) => {
    const port = server.address()?.port;
    const addresses = localAddresses(port);
    res.json({ dashboardUrl: `http://localhost:${port}`,
      senderUrls: addresses.map(url => url.replace('http:', 'ws:') + '/ws/ingest'),
      flightTargets: addresses.map(url => new URL(url).host),
      pushUrls: addresses.map(url => `${url}/api/telemetry`) });
  });
  app.get('/api/status', (_req, res) => res.json(store.status(clock())));
  const send = (client, message) => {
    // A slow browser reconnects for a bounded snapshot rather than building a queue.
    if (client.readyState !== WebSocket.OPEN) return;
    if (client.bufferedAmount > 4 * 1024 * 1024) { client.close(1013, 'Slow viewer; reconnect for history'); return; }
    client.send(JSON.stringify(message));
  };
  const ingest = (batch, now) => {
    const result = store.ingest(batch, now);
    if (result.samples.length && wss.clients.size) {
      const message = { type: 'telemetry', samples: result.samples, status: store.status(now) };
      for (const client of wss.clients) send(client, message);
    }
    return result;
  };
  flightReceiver.on('message', data => {
    if (data.length > MAX_FLIGHT_PACKET_BYTES) return;
    const now = clock();
    let batch;
    try {
      batch = parseAerolotlPacket(JSON.parse(data.toString()), now);
    } catch {
      return;
    }
    ingest(batch, now);
  });
  app.post('/api/telemetry', (req, res, next) => {
    try {
      const now = clock();
      const batch = parseSensorLogger(req.body, now);
      const result = ingest(batch, now);
      if (result.conflict) return res.status(409).json({ error: 'Another sender is streaming. Stop it and wait two seconds.' });
      res.json({ ok: true, accepted: result.samples.length, invalid: batch.invalid,
        unsupported: batch.unsupported, ignored: result.ignored, duplicateBatch: result.duplicateBatch });
    } catch (error) { next(error); }
  });
  const threeDirectory = new URL('../node_modules/three/', import.meta.url);
  app.use('/vendor/three', express.static(fileURLToPath(new URL('build', threeDirectory))));
  app.use('/vendor/three-addons', express.static(fileURLToPath(new URL('examples/jsm', threeDirectory))));
  app.use(express.static(fileURLToPath(new URL('../public', import.meta.url))));
  app.use((error, _req, res, _next) => {
    const status = error instanceof InputError || error.type === 'entity.parse.failed' ? 400
      : error.type === 'entity.too.large' ? 413 : 500;
    if (status === 500) console.error(error);
    res.status(status).json({ error: status === 500 ? 'Receiver error' : error.message });
  });
  server.on('upgrade', (req, socket, head) => {
    const endpoint = req.url === '/ws' ? wss : req.url === '/ws/ingest' ? senders : null;
    if (!endpoint) { socket.destroy(); return; }
    endpoint.handleUpgrade(req, socket, head, client => endpoint.emit('connection', client, req));
  });
  wss.on('connection', client => { client.on('error', () => {}); send(client, store.snapshot(clock())); });
  senders.on('connection', client => {
    client.on('error', () => {});
    let session;
    client.on('message', (data, isBinary) => {
      if (client.readyState !== WebSocket.OPEN) return;
      const now = clock();
      let batch;
      try {
        if (isBinary) throw new Error('Expected JSON text.');
        batch = parseAerolotlPacket(JSON.parse(data.toString()), now);
      } catch {
        client.close(1007, 'Invalid Aerolotl telemetry packet.');
        return;
      }
      if (session && (batch.sourceId !== session.sourceId || batch.sessionId !== session.sessionId)) {
        client.close(1008, 'Start a new connection for each session.');
        return;
      }
      const result = ingest(batch, now);
      if (result.ignored === 'timebase-changed') {
        client.close(1008, 'Use one timestamp format per session.');
        return;
      }
      if (result.ignored === 'acceleration-kind-changed') {
        client.close(1008, 'Use one acceleration kind per session.');
        return;
      }
      if (result.conflict || result.ignored === 'retired-session') {
        client.close(1008, result.conflict ? 'Another sender is streaming. Stop it and try again.' : 'This session has ended.');
        return;
      }
      if (!session) {
        session = { sourceId: batch.sourceId, sessionId: batch.sessionId };
        send(client, { type: 'accepted' });
      }
    });
  });
  const timer = setInterval(() => {
    const message = { type: 'status', status: store.status(clock()) };
    for (const client of wss.clients) send(client, message);
  }, 1000);
  timer.unref();
  return { app, server, store, wss, flightReceiver, close: async () => {
    clearInterval(timer);
    for (const client of wss.clients) client.terminate();
    for (const client of senders.clients) client.terminate();
    wss.close();
    senders.close();
    await Promise.all([
      new Promise(resolve => flightReceiver.close(resolve)),
      server.listening && new Promise(resolve => {
        server.close(resolve);
        server.closeAllConnections();
      }),
    ]);
  } };
}
