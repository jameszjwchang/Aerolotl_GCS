import { Quaternion, Vector3 } from 'three';
import { axisColors } from './chart.js';

export function createReferenceAxes(stage) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('rocket-axes');
  svg.setAttribute('viewBox', '0 0 128 128');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Reference axes: positive X, Y, and Z. A circled dot points toward you; a circled cross points away.');
  svg.innerHTML = `
    <text class="rocket-axes-title" x="64" y="16" text-anchor="middle">Reference axes</text>
    <circle cx="64" cy="72" r="2.5" fill="#555" />
    ${Object.entries(axisColors).map(([axis, color]) => `
      <g class="rocket-axis-${axis}" fill="${color}" stroke="${color}" stroke-width="2" stroke-linecap="round">
        <path class="axis-arrow" fill="none" />
        <g class="axis-end" style="display: none">
          <circle r="5" fill="white" />
          <circle class="axis-toward" r="1.6" stroke="none" />
          <path class="axis-away" d="M -2,-2 L 2,2 M -2,2 L 2,-2" />
        </g>
        <text class="axis-label" stroke="white" stroke-width="3" paint-order="stroke" text-anchor="middle" dominant-baseline="central">+${axis.toUpperCase()}</text>
      </g>`).join('')}`;
  stage.append(svg);

  const axes = ['x', 'y', 'z'].map((axis, index) => {
    const group = svg.querySelector(`.rocket-axis-${axis}`);
    return {
      direction: new Vector3().setComponent(index, 1),
      projected: new Vector3(),
      group,
      arrow: group.querySelector('.axis-arrow'),
      end: group.querySelector('.axis-end'),
      toward: group.querySelector('.axis-toward'),
      away: group.querySelector('.axis-away'),
      label: group.querySelector('.axis-label'),
    };
  });
  const viewRotation = new Quaternion();
  let previousCameraRotation = null;

  return {
    update(camera) {
      // Only the dragged camera affects this reference frame, never the phone's pose.
      if (previousCameraRotation?.equals(camera.quaternion)) return;
      previousCameraRotation ??= new Quaternion();
      previousCameraRotation.copy(camera.quaternion);
      viewRotation.copy(camera.quaternion).invert();
      for (const axis of axes) axis.projected.copy(axis.direction).applyQuaternion(viewRotation);
      const labels = [];
      // Draw the nearest axis last when the projected arrows cross.
      for (const axis of [...axes].sort((a, b) => a.projected.z - b.projected.z)) {
        const { x, y, z } = axis.projected;
        const length = Math.hypot(x, y);
        const tipX = 64 + x * 30;
        const tipY = 72 - y * 30;
        const endOn = length < 0.2;
        const dx = length ? x / length : 0;
        const dy = length ? -y / length : 0;
        axis.arrow.setAttribute('d', endOn ? ''
          : `M 64,72 L ${tipX},${tipY} m ${-dx * 7 - dy * 3.5},${-dy * 7 + dx * 3.5} L ${tipX},${tipY} l ${-dx * 7 + dy * 3.5},${-dy * 7 - dx * 3.5}`);
        // A dot/cross keeps an axis visible even when it points straight out/in.
        axis.end.style.display = endOn ? '' : 'none';
        axis.end.setAttribute('transform', `translate(${tipX} ${tipY})`);
        axis.toward.style.display = z > 0 ? '' : 'none';
        axis.away.style.display = z > 0 ? 'none' : '';
        const labelX = tipX + (endOn ? 19 : dx * 15);
        let labelY = tipY + (endOn ? 17 : dy * 15);
        // Keep both labels readable when two axes project in the same direction.
        if (labels.some(label => Math.abs(label.x - labelX) < 27 && Math.abs(label.y - labelY) < 18)) {
          labelY += labelY > 72 ? -18 : 18;
        }
        labels.push({ x: labelX, y: labelY });
        axis.label.setAttribute('x', labelX);
        axis.label.setAttribute('y', labelY);
        svg.append(axis.group);
      }
    },
  };
}
