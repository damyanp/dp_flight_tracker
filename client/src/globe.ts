import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export const EARTH_RADIUS = 1;

export interface Globe {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  controls: OrbitControls;
  earth: THREE.Mesh;
  routeGroup: THREE.Group;
}

export function createGlobe(canvas: HTMLCanvasElement): Globe {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x05070d);

  const camera = new THREE.PerspectiveCamera(
    45,
    window.innerWidth / window.innerHeight,
    0.01,
    100,
  );
  camera.position.set(0, 0, 3);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight, false);

  scene.add(new THREE.AmbientLight(0xffffff, 0.55));
  const sun = new THREE.DirectionalLight(0xffffff, 0.9);
  sun.position.set(5, 3, 5);
  scene.add(sun);

  const geometry = new THREE.SphereGeometry(EARTH_RADIUS, 96, 96);
  const loader = new THREE.TextureLoader();
  const texture = loader.load('/earth.jpg');
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.MeshPhongMaterial({
    map: texture,
    color: 0xffffff,
    specular: 0x222233,
    shininess: 8,
  });
  const earth = new THREE.Mesh(geometry, material);
  scene.add(earth);

  const stars = makeStarfield();
  scene.add(stars);

  const routeGroup = new THREE.Group();
  scene.add(routeGroup);

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 1.3;
  controls.maxDistance = 8;
  controls.rotateSpeed = 0.6;
  controls.zoomSpeed = 0.8;

  function onResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight, false);
  }
  window.addEventListener('resize', onResize);

  function animate() {
    controls.update();
    renderer.render(scene, camera);
    requestAnimationFrame(animate);
  }
  requestAnimationFrame(animate);

  return { scene, camera, renderer, controls, earth, routeGroup };
}

function makeStarfield(): THREE.Points {
  const count = 1500;
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const r = 40 + Math.random() * 10;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    positions[i * 3 + 0] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.cos(phi);
    positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.PointsMaterial({ color: 0xffffff, size: 0.05, sizeAttenuation: true });
  return new THREE.Points(geo, mat);
}

/** Convert (lat, lon) in degrees to a 3D point on a sphere of given radius. */
export function latLonToVec3(lat: number, lon: number, radius = EARTH_RADIUS): THREE.Vector3 {
  const phi = THREE.MathUtils.degToRad(90 - lat);
  const theta = THREE.MathUtils.degToRad(lon + 180);
  return new THREE.Vector3(
    -radius * Math.sin(phi) * Math.cos(theta),
    radius * Math.cos(phi),
    radius * Math.sin(phi) * Math.sin(theta),
  );
}

/** Smoothly orient the camera so it looks at the midpoint of an arc. */
export function focusOn(globe: Globe, target: THREE.Vector3): void {
  const dir = target.clone().normalize();
  const distance = globe.camera.position.length();
  globe.camera.position.copy(dir.multiplyScalar(distance));
  globe.controls.target.set(0, 0, 0);
  globe.controls.update();
}
