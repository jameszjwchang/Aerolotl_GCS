// Shared by the receiver and browser.
export const SENSOR_IDS = ['acceleration', 'gyro', 'pressure', 'altitude', 'position'];
export const HISTORY_MS = 30000;
export const MAX_SAMPLES = 10000;

export class History {
  constructor() { this.samples = []; this.overflow = 0; }
  add(sample) {
    const a = this.samples;
    let lo = 0, hi = a.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (a[mid].measuredAtMs < sample.measuredAtMs) lo = mid + 1;
      else hi = mid;
    }
    if (a[lo]?.measuredAtMs === sample.measuredAtMs) return 'duplicate';
    if (a.length && sample.measuredAtMs < a.at(-1).measuredAtMs - HISTORY_MS) return 'expired';
    a.splice(lo, 0, sample);
    this.prune();
    if (a.length > MAX_SAMPLES) {
      this.overflow += a.length - MAX_SAMPLES;
      a.splice(0, a.length - MAX_SAMPLES);
    }
    return 'accepted';
  }
  prune(now) {
    const a = this.samples;
    const cutoff = a.length ? a.at(-1).measuredAtMs - HISTORY_MS : 0;
    let n = 0;
    while (n < a.length && (a[n].measuredAtMs < cutoff ||
      (now !== undefined && now - a[n].receivedAtMs > HISTORY_MS))) n++;
    if (n) a.splice(0, n);
  }
  get latest() { return this.samples.at(-1) ?? null; }
  diagnostics() {
    const a = this.samples;
    if (!a.length) return { rateHz: null, gaps: 0, maxIntervalMs: null, retained: 0, overflow: this.overflow };
    const cutoff = a.at(-1).measuredAtMs - 10000;
    const first = a.findIndex(s => s.measuredAtMs >= cutoff);
    let gaps = 0, maxIntervalMs = 0;
    for (let i = first + 1; i < a.length; i++) {
      const dt = a[i].measuredAtMs - a[i - 1].measuredAtMs;
      maxIntervalMs = Math.max(maxIntervalMs, dt);
      if (['acceleration', 'gyro'].includes(a[i].sensor) && dt > 25) gaps++;
    }
    const span = a.at(-1).measuredAtMs - a[first].measuredAtMs;
    return { rateHz: span > 0 ? (a.length - first - 1) * 1000 / span : null,
      gaps, maxIntervalMs: span > 0 ? maxIntervalMs : null, retained: a.length, overflow: this.overflow };
  }
}

export class TelemetryStore {
  constructor() {
    this.sourceId = null;
    this.sessionId = null;
    this.retired = new Set();
    this.reset();
  }
  reset() {
    this.histories = Object.fromEntries(SENSOR_IDS.map(id => [id, new History()]));
    this.messageIds = new Set();
    this.lastReceivedAtMs = null;
    this.lastBatchAtMs = null;
    this.accelerationKind = undefined;
    this.intervals = [];
    this.totals = { batches: 0, accepted: 0, duplicates: 0, expired: 0, invalid: 0, unsupported: 0 };
  }
  ingest(batch, now = Date.now()) {
    if (batch.probe) return { samples: [], probe: true };
    const key = JSON.stringify([batch.sourceId, batch.sessionId]);
    if (this.retired.has(key)) return { samples: [], ignored: 'retired-session' };
    const changed = batch.sourceId !== this.sourceId || batch.sessionId !== this.sessionId;
    if (!changed && batch.timebase !== this.timebase) return { samples: [], ignored: 'timebase-changed' };
    const accelerationKind = batch.samples.find(sample => sample.sensor === 'acceleration')?.accelerationKind;
    if (!changed && this.accelerationKind && accelerationKind && this.accelerationKind !== accelerationKind) {
      return { samples: [], ignored: 'acceleration-kind-changed' };
    }
    if (changed && this.sourceId && batch.sourceId !== this.sourceId &&
      now - this.lastReceivedAtMs < 2000) return { samples: [], conflict: true };
    // Unsupported/invalid-only pushes never claim the source or reset a session.
    if (changed && batch.samples.length === 0) return { samples: [], ignored: 'no-supported-readings' };
    if (changed) {
      if (this.sourceId) this.retired.add(JSON.stringify([this.sourceId, this.sessionId]));
      if (this.retired.size > 100) this.retired.delete(this.retired.values().next().value);
      this.reset();
      this.sourceId = batch.sourceId;
      this.sessionId = batch.sessionId;
      this.timebase = batch.timebase;
    }
    if (batch.messageId !== undefined && this.messageIds.has(batch.messageId)) {
      return { samples: [], duplicateBatch: true };
    }
    if (batch.messageId !== undefined) {
      this.messageIds.add(batch.messageId);
      if (this.messageIds.size > 10000) this.messageIds.delete(this.messageIds.values().next().value);
    }
    this.accelerationKind ??= accelerationKind;
    this.totals.batches++;
    this.totals.invalid += batch.invalid;
    this.totals.unsupported += batch.unsupported;
    if (this.lastBatchAtMs !== null) {
      this.intervals.push(Math.max(0, now - this.lastBatchAtMs));
      if (this.intervals.length > 300) this.intervals.shift();
    }
    this.lastBatchAtMs = now;
    this.prune(now);
    const samples = [];
    for (const sample of batch.samples) {
      const result = this.histories[sample.sensor].add(sample);
      this.totals[result === 'duplicate' ? 'duplicates' : result]++;
      if (result === 'accepted') samples.push(sample);
    }
    if (samples.length) this.lastReceivedAtMs = now;
    return { samples, sessionChanged: changed };
  }
  prune(now) { for (const history of Object.values(this.histories)) history.prune(now); }
  status(now = Date.now()) {
    this.prune(now);
    const sorted = [...this.intervals].sort((a, b) => a - b);
    return { sourceId: this.sourceId, sessionId: this.sessionId,
      lastReceivedAtMs: this.lastReceivedAtMs, totals: this.totals,
      batchIntervalMs: this.intervals.at(-1) ?? null,
      batchP95Ms: sorted.length ? sorted[Math.ceil(sorted.length * .95) - 1] : null,
      sensors: Object.fromEntries(SENSOR_IDS.map(id => [id, {
        ...this.histories[id].diagnostics(), latest: this.histories[id].latest,
      }])) };
  }
  snapshot(now = Date.now()) {
    return { type: 'snapshot', status: this.status(now),
      samples: Object.values(this.histories).flatMap(h => h.samples) };
  }
}
