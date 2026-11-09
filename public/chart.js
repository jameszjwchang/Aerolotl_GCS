const plotInset = 41;
export const axisLines = [
  { label: 'solid', dash: [], ink: '#111' },
  { label: 'dashed', dash: [5, 3], ink: '#555' },
  { label: 'dotted', dash: [1, 3], ink: '#888' },
];

export function plot(canvas, samples, { keys, offset, start, end, floor, gapMs }) {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (!w || !h) return;
  const dpr = window.devicePixelRatio || 1;
  const pw = Math.round(w * dpr), ph = Math.round(h * dpr);
  if (canvas.width !== pw || canvas.height !== ph) { canvas.width = pw; canvas.height = ph; }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const left = plotInset, right = Math.max(left + 1, w - 5), top = 8, bottom = h - 8;
  let first = 0;
  while (first < samples.length && samples[first].measuredAtMs < start) first++;
  let min = Infinity, max = -Infinity;
  for (let i = first; i < samples.length; i++) {
    for (const key of keys) {
      const v = samples[i].values[key];
      if (!Number.isFinite(v)) continue;
      min = Math.min(min, v - offset);
      max = Math.max(max, v - offset);
    }
  }
  const hasData = min !== Infinity;
  if (keys.length > 1) {
    max = hasData ? Math.max(floor, Math.abs(min), Math.abs(max)) * 1.08 : floor;
    min = -max;
  } else {
    const center = hasData ? min + (max - min) / 2 : 0;
    const span = hasData ? Math.max(floor, (max - min) * 1.16) : floor;
    min = center - span / 2;
    max = center + span / 2;
  }
  const x = t => left + (t - start) / (end - start) * (right - left);
  const y = v => bottom - (v - min) / (max - min) * (bottom - top);
  ctx.strokeStyle = '#ddd';
  ctx.fillStyle = '#333';
  ctx.font = '11px serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.beginPath();
  for (let i = 0; i <= 3; i++) {
    const px = left + (right - left) * i / 3;
    ctx.moveTo(px, top);
    ctx.lineTo(px, bottom);
  }
  for (let i = 0; i <= 2; i++) {
    const py = top + (bottom - top) * i / 2;
    ctx.moveTo(left, py);
    ctx.lineTo(right, py);
    if (hasData) ctx.fillText((max - (max - min) * i / 2).toFixed(keys.length > 1 ? 1 : 2), left - 4, py, left - 7);
  }
  ctx.stroke();
  if (!hasData) {
    ctx.textAlign = 'center';
    ctx.fillText('Awaiting data', (left + right) / 2, h / 2);
    return;
  }
  ctx.save();
  ctx.beginPath();
  ctx.rect(left, 0, right - left + 1, h);
  ctx.clip();
  keys.forEach((key, axis) => {
    const { ink, dash } = axisLines[axis];
    ctx.strokeStyle = ink;
    ctx.fillStyle = ink;
    ctx.setLineDash(dash);
    ctx.lineWidth = 1.35;
    ctx.beginPath();
    let previous = null, lastPoint = null, inSegment = false;
    function markSinglePoint() {
      if (lastPoint && !inSegment) ctx.fillRect(lastPoint[0] - 1, lastPoint[1] - 1, 2, 2);
    }
    for (let i = first; i < samples.length; i++) {
      const sample = samples[i];
      const v = sample.values[key];
      if (!Number.isFinite(v)) {
        markSinglePoint();
        previous = lastPoint = null;
        inSegment = false;
        continue;
      }
      const px = x(sample.measuredAtMs), py = y(v - offset);
      if (previous === null || sample.measuredAtMs - previous > gapMs) {
        markSinglePoint();
        ctx.moveTo(px, py);
        inSegment = false;
      } else { ctx.lineTo(px, py); inSegment = true; }
      previous = sample.measuredAtMs;
      lastPoint = [px, py];
    }
    markSinglePoint();
    ctx.stroke();
  });
  ctx.restore();
}
