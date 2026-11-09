// The only module that knows Sensor Logger's wire format. Incoming units:
// https://github.com/tszheichoi/awesome-sensor-logger/blob/main/UNITS.md
export class InputError extends Error {}

const finite = value => typeof value === 'number' && Number.isFinite(value) ? value : null;

function timestampMs(value) {
  // Sensor Logger sends epoch nanoseconds (numbers, or strings in some exports).
  if (typeof value === 'string' && /^\d{16,22}$/.test(value)) {
    const ns = BigInt(value);
    return Number(ns / 1000000n) + Number(ns % 1000000n) / 1e6;
  }
  return typeof value === 'number' && Number.isFinite(value) && value >= 1e15
    ? value / 1e6 : null;
}

export function parseSensorLogger(body, receivedAtMs = Date.now()) {
  if (!body || !Array.isArray(body.payload) || body.payload.length > 20000) {
    throw new InputError('Expected a Sensor Logger JSON object with a payload array (maximum 20,000 records).');
  }
  // Empty payloads are useful for Sensor Logger's connection test.
  if (body.payload.length === 0) return { probe: true, samples: [], invalid: 0, unsupported: 0 };
  for (const key of ['deviceId', 'sessionId']) {
    if (typeof body[key] !== 'string' || !body[key].length || body[key].length > 200) {
      throw new InputError(`Missing or invalid ${key}. Use Sensor Logger HTTP Push.`);
    }
  }
  if (body.messageId !== undefined && (!Number.isSafeInteger(body.messageId) || body.messageId < 0)) {
    throw new InputError('messageId must be a nonnegative integer.');
  }
  const samples = [];
  let invalid = 0;
  let unsupported = 0;
  for (const record of body.payload) {
    if (!record || !['accelerometer', 'gyroscope', 'barometer'].includes(record.name)) {
      unsupported++;
      continue;
    }
    const measuredAtMs = timestampMs(record.time);
    const values = record.values;
    if (measuredAtMs === null || !values || typeof values !== 'object') {
      invalid++;
      continue;
    }
    const base = { source: 'sensor-logger', sourceId: body.deviceId,
      sessionId: body.sessionId, measuredAtMs, receivedAtMs };
    if (record.name === 'barometer') {
      let found = false;
      for (const [sensor, field, unit] of [['pressure', 'pressure', 'hPa'], ['altitude', 'relativeAltitude', 'm']]) {
        const value = finite(values[field]);
        if (value !== null && (sensor !== 'pressure' || value > 0)) {
          samples.push({ ...base, sensor, unit, values: { value } });
          found = true;
        }
      }
      if (!found) invalid++;
    } else {
      const vector = Object.fromEntries(['x', 'y', 'z'].map(axis => [axis, finite(values[axis])]));
      if (Object.values(vector).every(value => value === null)) { invalid++; continue; }
      samples.push({ ...base, sensor: record.name === 'accelerometer' ? 'acceleration' : 'gyro',
        unit: record.name === 'accelerometer' ? 'm/s²' : 'rad/s', values: vector });
    }
  }
  return { sourceId: body.deviceId, sessionId: body.sessionId, messageId: body.messageId,
    samples, invalid, unsupported };
}
