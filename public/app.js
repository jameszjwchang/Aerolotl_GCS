import { History, HISTORY_MS, SENSOR_IDS } from './telemetry.js';
import { openStream } from './stream.js';
import { axisLines, plot } from './chart.js';

const $ = id => document.getElementById(id);
const awaitingData = '…';
const definitions = {
  acceleration: { title: 'Accelerometer', note: 'Gravity removed · m/s²', keys: ['x', 'y', 'z'], floor: 1, gapMs: 25 },
  gyro: { title: 'Gyroscope', note: 'Rotation rate · rad/s', keys: ['x', 'y', 'z'], floor: 0.2, gapMs: 25 },
  pressure: { title: 'Pressure', note: 'Ambient pressure · hPa', keys: ['value'], floor: 0.5, gapMs: 3000 },
  altitude: { title: 'Relative altitude', note: 'Change from reference · m', keys: ['value'], floor: 0.5, gapMs: 3000 },
};
const panels = {};
let status = null;
let connected = false;
let altitudeOffset = 0;
let dirty = true;
let rocketView;

for (const [sensor, config] of Object.entries(definitions)) {
  const panel = $('sensor-panel').content.firstElementChild.cloneNode(true);
  panel.querySelector('h3').textContent = config.title;
  panel.querySelector('.sensor-note').textContent = config.note;
  const canvas = panel.querySelector('canvas');
  canvas.setAttribute('aria-label', config.title + ', last 30 seconds');
  const values = panel.querySelector('.values');
  const outputs = config.keys.map((key, i) => {
    const div = document.createElement('div');
    div.className = 'readout';
    const label = document.createElement('span');
    const description = key === 'value' ? (sensor === 'pressure' ? 'hPa' : 'm')
      : key.toUpperCase() + ' (' + axisLines[i].label + ')';
    label.textContent = description + ' ';
    const output = document.createElement('output');
    output.setAttribute('aria-label', config.title + (key === 'value' ? '' : ' ' + key.toUpperCase()));
    output.setAttribute('aria-live', 'off');
    output.textContent = awaitingData;
    div.append(label, output);
    values.append(div);
    return output;
  });
  const zero = sensor === 'altitude' ? document.createElement('button') : null;
  if (zero) {
    zero.type = 'button';
    zero.textContent = 'Zero altitude';
    zero.disabled = true;
    zero.addEventListener('click', () => {
      if (panel.dataset.state === 'live') {
        altitudeOffset = panels.altitude.history.latest?.values.value ?? altitudeOffset;
        dirty = true;
      }
    });
    values.append(zero);
  }
  $(config.keys.length === 3 ? 'motion-panels' : 'environment-panels').append(panel);
  panels[sensor] = { config, panel, canvas, outputs, zero, rate: panel.querySelector('.sensor-rate'), history: new History() };
}

const setText = (node, value) => { if (node.textContent !== value) node.textContent = value; };
const ageText = ms => ms < 1000 ? Math.round(ms) + ' ms' : (ms / 1000).toFixed(1) + ' s';
const intervalText = ms => Number.isFinite(ms) ? ageText(ms) : awaitingData;

function showAddresses(container, urls) {
  container.replaceChildren();
  for (const url of urls) {
    const row = document.createElement('div');
    row.className = 'address';
    const code = document.createElement('code');
    code.textContent = url;
    const copy = document.createElement('button');
    copy.textContent = 'Copy URL';
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(url);
        copy.textContent = 'Copied';
      } catch {
        const range = document.createRange();
        range.selectNodeContents(code);
        window.getSelection().removeAllRanges();
        window.getSelection().addRange(range);
        copy.textContent = 'URL selected';
      }
      setTimeout(() => { copy.textContent = 'Copy URL'; }, 1500);
    });
    row.append(code, copy);
    container.append(row);
  }
  if (!urls.length) container.textContent = 'No Wi-Fi address found. Connect your computer to Wi-Fi, then reload.';
}

async function loadAddresses() {
  try {
    const response = await fetch('/api/config');
    if (!response.ok) throw new Error('Receiver unavailable');
    const { senderUrls } = await response.json();
    showAddresses($('sender-addresses'), senderUrls);
  } catch {
    $('sender-addresses').textContent = 'Could not read local addresses. Check the receiver terminal.';
  }
}

let setupCollapsed = false;
openStream({
  onConnection(value) {
    connected = value;
    dirty = true;
  },
  onMessage(message) {
    const changed = message.status.sourceId !== status?.sourceId || message.status.sessionId !== status?.sessionId;
    if (changed || message.type === 'snapshot') {
      for (const { history } of Object.values(panels)) { history.samples.length = 0; history.overflow = 0; }
      if (changed) altitudeOffset = 0;
    }
    status = message.status;
    rocketView?.ingest(message);
    for (const sample of message.samples ?? []) panels[sample.sensor]?.history.add(sample);
    if (status.lastReceivedAtMs !== null && !setupCollapsed) {
      $('setup').open = false;
      setupCollapsed = true;
    }
    dirty = true;
  },
});
async function loadRocketView() {
  const reportError = (message, hint, error) => {
    console.error('Rocket view could not load', error);
    setText(document.querySelector('.rocket-live-state'), message + '. ' + hint);
  };

  let createRocketView;
  try {
    ({ createRocketView } = await import('./rocket-view.js'));
  } catch (error) {
    reportError('Rocket files could not load', 'Restart the GCS receiver, then refresh this page.', error);
    return;
  }
  try {
    rocketView = await createRocketView($('rocket-view'));
    if (status) rocketView.ingest({ type: 'snapshot', status });
  } catch (error) {
    reportError('3D view unavailable', error.message, error);
  }
}

loadAddresses();
loadRocketView();
const resize = new ResizeObserver(() => { dirty = true; });
for (const { canvas } of Object.values(panels)) resize.observe(canvas);

let lastReadout = -Infinity;
function render(frame) {
  const now = Date.now();
  rocketView?.render(now, connected);
  const updateReadout = dirty || frame - lastReadout >= 200;
  if (updateReadout) {
    lastReadout = frame;
    const last = status?.lastReceivedAtMs;
    const age = last == null ? null : Math.max(0, now - last);
    const live = age !== null && age < 2000 && connected;
    setText($('link-state'), !connected ? 'Receiver disconnected · retrying'
      : age === null ? 'Waiting for iPhone' : !live ? 'Telemetry stale'
        : 'Receiving iPhone telemetry');
    setText($('last-seen'), age === null ? 'No data received' : 'Last reading received ' + ageText(age) + ' ago');
    setText($('sample-count'), status?.sessionId ? status.totals.accepted.toLocaleString() : awaitingData);
    setText($('batch-interval'), intervalText(status?.batchIntervalMs));
    setText($('batch-p95'), intervalText(status?.batchP95Ms));
    setText($('motion-gaps'), status?.sensors.acceleration.latest || status?.sensors.gyro.latest
      ? status.sensors.acceleration.gaps + status.sensors.gyro.gaps : awaitingData);
    const overflow = SENSOR_IDS.reduce((total, id) => total + (status?.sensors[id]?.overflow ?? 0), 0);
    setText($('stream-notes'), 'Motion gaps are sample intervals over 25 ms. Packet timing measures arrivals at this computer.'
      + (overflow ? ' History capacity exceeded: ' + overflow.toLocaleString() + ' older readings removed.' : ''));
  }
  for (const [sensor, item] of Object.entries(panels)) {
    const { history, panel, canvas, outputs, rate, config, zero } = item;
    history.prune(now);
    const latest = history.latest;
    const state = !latest ? 'waiting' : !connected || now - latest.receivedAtMs >= 2000 ? 'stale' : 'live';
    const offset = sensor === 'altitude' ? altitudeOffset : 0;
    if (updateReadout) {
      panel.dataset.state = state;
      const hz = status?.sensors[sensor].rateHz;
      setText(rate, state === 'waiting' ? 'No readings' : state === 'stale' ? 'Stale'
        : Number.isFinite(hz) ? hz.toFixed(1) + ' Hz' : 'Sampling…');
      config.keys.forEach((key, i) => {
        const value = latest?.values[key];
        setText(outputs[i], Number.isFinite(value) ? (value - offset).toFixed(2) : awaitingData);
      });
      if (zero) zero.disabled = state !== 'live';
    }
    if (latest || dirty || item.hadData) {
      const end = latest ? latest.measuredAtMs + Math.max(0, now - latest.receivedAtMs) : now;
      plot(canvas, history.samples, { ...config, offset, start: end - HISTORY_MS, end });
      item.hadData = !!latest;
    }
  }
  dirty = false;
  requestAnimationFrame(render);
}
requestAnimationFrame(render);
