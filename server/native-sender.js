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

export function parseNativePacket(packet, receivedAtMs) {
  if (packet?.version !== 1 || !validId(packet.deviceId) || !validId(packet.sessionId) ||
      !Number.isSafeInteger(packet.sequence) || packet.sequence < 0 ||
      !Number.isFinite(packet.measuredAtMs) || packet.measuredAtMs < 1e12 || packet.measuredAtMs > 1e14) {
    throw new Error('Invalid Aerolotl packet header.');
  }

  const sourceId = 'native:' + packet.deviceId;
  const base = { source: 'aerolotl-ios', sourceId, sessionId: packet.sessionId,
    measuredAtMs: packet.measuredAtMs, receivedAtMs };
  const { motion, barometer, position } = packet;
  if ([motion, barometer, position].filter(value => value != null).length !== 1) {
    throw new Error('Expected one telemetry reading.');
  }
  let samples;
  if (motion && validVector(motion.acceleration) && validVector(motion.gyro)) {
    const attitude = motion.attitude === undefined ? undefined : quaternion(motion.attitude);
    samples = [
      { ...base, sensor: 'acceleration', unit: 'm/s²', values: vector(motion.acceleration) },
      { ...base, sensor: 'gyro', unit: 'rad/s', values: vector(motion.gyro), attitude },
    ];
  } else if (barometer && Number.isFinite(barometer.pressureHpa) &&
      barometer.pressureHpa > 0 && Number.isFinite(barometer.relativeAltitudeM)) {
    samples = [
      { ...base, sensor: 'pressure', unit: 'hPa', values: { value: barometer.pressureHpa } },
      { ...base, sensor: 'altitude', unit: 'm', values: { value: barometer.relativeAltitudeM } },
    ];
  } else if (position?.tracking === 'normal' && validVector(position.translation)) {
    samples = [{ ...base, sensor: 'position', unit: 'm', tracking: 'normal',
      values: vector(position.translation), attitude: quaternion(position.attitude) }];
  } else if (position?.tracking === 'limited' && position.translation == null && position.attitude == null) {
    samples = [{ ...base, sensor: 'position', unit: 'm', tracking: 'limited', values: {} }];
  } else {
    throw new Error('Invalid Aerolotl sensor values.');
  }
  return { sourceId, sessionId: packet.sessionId, messageId: packet.sequence,
    samples, invalid: 0, unsupported: 0 };
}
