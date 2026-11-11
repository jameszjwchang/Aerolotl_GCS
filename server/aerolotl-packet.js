const validVector = vector => vector && ['x', 'y', 'z'].every(axis => Number.isFinite(vector[axis]));
const validId = id => typeof id === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(id);
const vector = ({ x, y, z }) => ({ x, y, z });

function quaternion(value) {
  if (!validVector(value) || !Number.isFinite(value.w)) throw new Error('Invalid attitude.');
  const { x, y, z, w } = value;
  const length = Math.hypot(x, y, z, w);
  if (Math.abs(length - 1) > 0.05) throw new Error('Invalid attitude length.');
  return { x: x / length, y: y / length, z: z / length, w: w / length };
}

export const MAX_FLIGHT_PACKET_BYTES = 1200;

export function parseAerolotlPacket(packet, receivedAtMs) {
  if (packet?.version !== 1 || !validId(packet.deviceId) || !validId(packet.sessionId) ||
      !Number.isSafeInteger(packet.sequence) || packet.sequence < 0) {
    throw new Error('Invalid Aerolotl packet header.');
  }
  const { uptimeMs, measuredAtMs } = packet;
  const usesUptime = uptimeMs !== undefined;
  const validUptime = measuredAtMs === undefined && Number.isSafeInteger(uptimeMs) && uptimeMs >= 0;
  const validEpoch = Number.isFinite(measuredAtMs) && measuredAtMs >= 1e12 && measuredAtMs <= 1e14;
  if (usesUptime ? !validUptime : !validEpoch) {
    throw new Error('Expected one valid sample timestamp.');
  }

  const sourceId = 'native:' + packet.deviceId;
  // History uses differences between capture times within a session. Freshness uses arrival time.
  const base = { source: 'aerolotl', sourceId, sessionId: packet.sessionId,
    measuredAtMs: usesUptime ? uptimeMs : measuredAtMs, receivedAtMs };
  const { motion, barometer, position } = packet;
  if ([motion, barometer, position].filter(value => value != null).length !== 1) {
    throw new Error('Expected one telemetry reading.');
  }
  const samples = [];
  if (motion) {
    const { acceleration, accelerationKind = 'linear', gyro, attitude } = motion;
    if (!['linear', 'specific-force'].includes(accelerationKind) ||
        (acceleration !== undefined && !validVector(acceleration)) ||
        (gyro !== undefined && !validVector(gyro)) ||
        (attitude !== undefined && gyro === undefined)) {
      throw new Error('Invalid Aerolotl motion values.');
    }
    if (acceleration) samples.push({ ...base, sensor: 'acceleration', unit: 'm/s²',
      values: vector(acceleration), accelerationKind });
    if (gyro) samples.push({ ...base, sensor: 'gyro', unit: 'rad/s', values: vector(gyro),
      attitude: attitude === undefined ? undefined : quaternion(attitude) });
  } else if (barometer) {
    const { pressureHpa, relativeAltitudeM } = barometer;
    if (pressureHpa !== undefined) {
      if (!Number.isFinite(pressureHpa) || pressureHpa <= 0) throw new Error('Invalid pressure.');
      samples.push({ ...base, sensor: 'pressure', unit: 'hPa', values: { value: pressureHpa } });
    }
    if (relativeAltitudeM !== undefined) {
      if (!Number.isFinite(relativeAltitudeM)) throw new Error('Invalid relative altitude.');
      samples.push({ ...base, sensor: 'altitude', unit: 'm', values: { value: relativeAltitudeM } });
    }
  } else if (position?.tracking === 'normal' && validVector(position.translation)) {
    samples.push({ ...base, sensor: 'position', unit: 'm', tracking: 'normal',
      values: vector(position.translation), attitude: quaternion(position.attitude) });
  } else if (position?.tracking === 'limited' && position.translation == null && position.attitude == null) {
    samples.push({ ...base, sensor: 'position', unit: 'm', tracking: 'limited', values: {} });
  }
  if (!samples.length) throw new Error('Expected at least one valid sensor reading.');
  return { sourceId, sessionId: packet.sessionId, messageId: packet.sequence,
    timebase: usesUptime ? 'uptime' : 'epoch', samples, invalid: 0, unsupported: 0 };
}
