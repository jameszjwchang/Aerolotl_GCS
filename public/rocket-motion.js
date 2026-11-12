import { Quaternion, Vector3 } from 'three';

// Right-handed input-to-viewer basis: +Z -> +X, +Y -> +Y, +X -> -Z.
// A quaternion's vector part changes basis in the same way as a sensor vector.
const toViewerVector = ({ x, y, z }, out = new Vector3()) => out.set(z, y, -x);
const toViewerQuaternion = ({ x, y, z, w }) => new Quaternion(z, y, -x, w);

function bodyToMotionReference(sample) {
  // The motion packet maps reference axes to the sender's body axes.
  return toViewerQuaternion(sample.attitude).invert();
}

export class RocketMotion {
  constructor() {
    this.reset();
  }

  reset() {
    this.orientation = new Quaternion();
    this.acceleration = null;
    this.gyro = null;
    this.attitudeOrigin = null;
  }

  accept(sample) {
    if (sample.sensor === 'acceleration' && this.isNewer(sample, this.acceleration)) {
      this.acceleration = sample;
    } else if (sample.sensor === 'gyro' && this.isNewer(sample, this.gyro)) {
      this.updateOrientation(sample);
      this.gyro = sample;
    }
  }

  isNewer(sample, previous) {
    return !previous || sample.measuredAtMs > previous.measuredAtMs;
  }

  updateOrientation(sample) {
    if (sample.attitude) {
      const attitude = bodyToMotionReference(sample);
      this.attitudeOrigin ??= attitude.clone().invert();
      this.orientation.copy(this.attitudeOrigin).multiply(attitude).normalize();
      return;
    }
    // Without an attitude quaternion, integrate angular velocity in the body frame.
    const dt = this.gyro ? (sample.measuredAtMs - this.gyro.measuredAtMs) / 1000 : 0;
    const { x, y, z } = sample.values;
    if (dt <= 0 || dt > 0.1 || ![x, y, z].every(Number.isFinite)) return;
    const axis = toViewerVector(sample.values);
    const rate = axis.length();
    if (rate > 0) {
      const step = new Quaternion().setFromAxisAngle(axis.divideScalar(rate), rate * dt);
      this.orientation.multiply(step).normalize();
    }
  }

  zero() {
    this.attitudeOrigin = this.gyro?.attitude ? bodyToMotionReference(this.gyro).invert() : null;
    this.orientation.identity();
  }

  accelerationInScene(out) {
    const value = this.acceleration?.values;
    if (!value || ![value.x, value.y, value.z].every(Number.isFinite)) return out.set(0, 0, 0);
    return toViewerVector(value, out).applyQuaternion(this.orientation);
  }
}
