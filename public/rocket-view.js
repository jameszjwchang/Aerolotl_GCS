import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RocketMotion } from './rocket-motion.js';

const fresh = (sample, now) => !!sample && now - sample.receivedAtMs < 2000;
const setText = (element, text) => {
  if (element.textContent !== text) element.textContent = text;
};

export async function createRocketView(element) {
  const stage = element.querySelector('.rocket-stage');
  const state = element.querySelector('.rocket-live-state');
  const accelerationLabel = element.querySelector('.rocket-acceleration-label');
  const magnitude = element.querySelector('.rocket-magnitude');
  const zero = element.querySelector('.rocket-zero');
  const motion = new RocketMotion();
  let source = null;
  let renderNeeded = true;
  let visible = true;

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
  } catch (error) {
    throw new Error('This browser could not start WebGL. Try opening the dashboard in a browser with WebGL enabled.', { cause: error });
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.domElement.setAttribute('aria-label', '3D rocket showing orientation and acceleration');
  renderer.domElement.setAttribute('role', 'img');
  stage.prepend(renderer.domElement);

  try {
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(39, 1, 0.05, 60);
    camera.position.set(2.9, 1.8, 5.6);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enablePan = false;
    controls.minDistance = 2.5;
    controls.maxDistance = 16;
    controls.addEventListener('change', () => { renderNeeded = true; });
    scene.add(new THREE.HemisphereLight(0xffffff, 0x777777, 1.15));
    const key = new THREE.DirectionalLight(0xffffff, 1.8);
    key.position.set(3, 5, 4);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.65);
    fill.position.set(-4, 2, -3);
    scene.add(fill);

    const rocket = new THREE.Group();
    scene.add(rocket);
    const { scene: model } = await new GLTFLoader().loadAsync('/models/rocket.gltf');
    // The exported nose points along +Z. Align it with the viewer's +Y axis.
    model.rotation.x = -Math.PI / 2;
    const bounds = new THREE.Box3().setFromObject(model);
    const size = bounds.getSize(new THREE.Vector3());
    const scale = 2.4 / Math.max(size.x, size.y, size.z);
    model.scale.multiplyScalar(scale);
    model.position.addScaledVector(bounds.getCenter(new THREE.Vector3()), -scale);
    rocket.add(model);

    const acceleration = new THREE.Vector3();
    const direction = new THREE.Vector3(0, 1, 0);
    const arrow = new THREE.ArrowHelper(direction, new THREE.Vector3(), 1, 0x111111, 0.28, 0.15);
    arrow.traverse(part => {
      if (part.material) {
        part.material.depthTest = false;
        part.material.depthWrite = false;
        part.renderOrder = 2;
      }
    });
    arrow.visible = false;
    scene.add(arrow);

    function resize() {
      const width = stage.clientWidth;
      const height = stage.clientHeight;
      if (!width || !height) return;
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderNeeded = true;
    }
    new ResizeObserver(resize).observe(stage);
    new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      if (visible) renderNeeded = true;
    }).observe(stage);
    resize();

    zero.addEventListener('click', () => {
      motion.zero();
      renderNeeded = true;
    });

    return {
      ingest(message) {
        const key = JSON.stringify([message.status.sourceId, message.status.sessionId]);
        if (key !== source) {
          motion.reset();
          source = key;
        }
        // Use each motion sensor's latest reading from reconnect snapshots.
        if (message.type === 'snapshot') {
          for (const sensor of ['gyro', 'acceleration']) {
            const sample = message.status.sensors[sensor]?.latest;
            if (sample) motion.accept(sample);
          }
        } else {
          for (const sample of message.samples ?? []) motion.accept(sample);
        }
        renderNeeded = true;
      },
      render(now, connected) {
        if (!visible) return;
        const orientationLive = connected && fresh(motion.gyro, now);
        const accelerationLive = connected && fresh(motion.acceleration, now);
        zero.disabled = !orientationLive;
        setText(state, orientationLive ? (motion.gyro.attitude ? 'Live orientation' : 'Live gyro · may drift')
          : motion.gyro ? 'Motion stream paused' : 'Waiting for motion');

        motion.accelerationInScene(acceleration);
        const accelerationMagnitude = acceleration.length();
        setText(accelerationLabel, motion.acceleration?.accelerationKind === 'specific-force'
          ? 'Specific force' : 'Acceleration (without gravity)');
        setText(magnitude, accelerationLive ? accelerationMagnitude.toFixed(2) : '…');

        const showArrow = accelerationLive && accelerationMagnitude >= 0.06;
        if (!renderNeeded && arrow.visible === showArrow) return;
        rocket.quaternion.copy(motion.orientation);
        arrow.visible = showArrow;
        if (showArrow) {
          const length = Math.min(2.7, 0.12 + accelerationMagnitude * 0.36);
          arrow.setDirection(direction.copy(acceleration).normalize());
          arrow.setLength(length, Math.min(0.28, length * 0.45), Math.min(0.17, length * 0.27));
        }
        controls.update();
        renderer.render(scene, camera);
        renderNeeded = false;
      },
    };
  } catch (error) {
    renderer.dispose();
    renderer.domElement.remove();
    throw new Error('The rocket model could not load. Refresh the dashboard to try again.', { cause: error });
  }
}
