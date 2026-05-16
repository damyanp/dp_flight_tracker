import * as THREE from 'three';
import { EARTH_RADIUS, type Globe, latLonToVec3 } from './globe.js';

const SURFACE_OFFSET = 1.005;

const LAYER_ORDER: Record<string, number> = {
  'great-circle': 0,
  markers: 1,
  filed: 2,
  waypoints: 3,
  track: 4,
  aircraft: 5,
};

export interface RouteEndpoint {
  lat: number;
  lon: number;
  label: string;
  color?: number;
}

/** Remove all previously drawn routes / markers (optionally only one named layer). */
export function clearRoutes(globe: Globe, layerName?: string): void {
  for (const child of [...globe.routeGroup.children]) {
    if (layerName && (child as THREE.Object3D & { userData: { layer?: string } }).userData.layer !== layerName) {
      continue;
    }
    globe.routeGroup.remove(child);
    disposeObject(child);
  }
}

export function setLayerVisible(globe: Globe, layerName: string, visible: boolean): void {
  for (const child of globe.routeGroup.children) {
    if ((child.userData as { layer?: string }).layer === layerName) {
      child.visible = visible;
    }
    // Aircraft icon shares track-layer visibility.
    if (layerName === 'track' && (child.userData as { layer?: string }).layer === 'aircraft') {
      child.visible = visible;
    }
  }
}

function tagLayer<T extends THREE.Object3D>(obj: T, layer: string): T {
  obj.userData.layer = layer;
  obj.renderOrder = LAYER_ORDER[layer] ?? 0;
  return obj;
}

function buildTube(points: THREE.Vector3[], radius: number, color: number): THREE.Mesh {
  const curve = new THREE.CatmullRomCurve3(points, false, 'catmullrom', 0.0);
  const tubularSegments = Math.max(64, points.length * 2);
  const geo = new THREE.TubeGeometry(curve, tubularSegments, radius, 8, false);
  const mat = new THREE.MeshBasicMaterial({ color });
  return new THREE.Mesh(geo, mat);
}

/**
 * Densify a sequence of lat/lon points by slerping along the great-circle
 * arc between each consecutive pair. This keeps the resulting polyline glued
 * to the sphere surface, so a spline through these points doesn't dip
 * beneath the Earth between widely-spaced waypoints.
 *
 * `maxStepRad` controls the maximum angular gap between output points
 * (in radians). ~0.5° produces smooth surface-hugging curves at any zoom.
 */
function densifyOnSphere(
  points: Array<{ lat: number; lon: number }>,
  radius: number,
  maxStepRad = (0.5 * Math.PI) / 180,
): THREE.Vector3[] {
  const unit: THREE.Vector3[] = [];
  for (const p of points) {
    if (
      typeof p.lat !== 'number' ||
      typeof p.lon !== 'number' ||
      Number.isNaN(p.lat) ||
      Number.isNaN(p.lon)
    )
      continue;
    const v = latLonToVec3(p.lat, p.lon, 1);
    if (unit.length === 0 || unit[unit.length - 1].distanceToSquared(v) > 1e-10) {
      unit.push(v);
    }
  }
  if (unit.length < 2) return unit.map((v) => v.clone().multiplyScalar(radius));

  const out: THREE.Vector3[] = [];
  for (let i = 0; i < unit.length - 1; i++) {
    const a = unit[i];
    const b = unit[i + 1];
    const angle = a.angleTo(b);
    const steps = Math.max(1, Math.ceil(angle / maxStepRad));
    const sinAngle = Math.sin(angle);
    for (let j = 0; j < steps; j++) {
      const t = j / steps;
      let p: THREE.Vector3;
      if (sinAngle < 1e-6) {
        p = a.clone().lerp(b, t);
      } else {
        const s1 = Math.sin((1 - t) * angle) / sinAngle;
        const s2 = Math.sin(t * angle) / sinAngle;
        p = a.clone().multiplyScalar(s1).add(b.clone().multiplyScalar(s2));
      }
      out.push(p.normalize().multiplyScalar(radius));
    }
  }
  // Add the final point.
  out.push(unit[unit.length - 1].clone().multiplyScalar(radius));
  return out;
}

/** Draw a great-circle arc between two lat/lon points. Returns midpoint. */
export function drawGreatCircle(
  globe: Globe,
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
  color = 0x6aa9ff,
  layer = 'great-circle',
  tubeRadius = 0.0015,
): THREE.Vector3 {
  const start = latLonToVec3(a.lat, a.lon, EARTH_RADIUS).normalize();
  const end = latLonToVec3(b.lat, b.lon, EARTH_RADIUS).normalize();

  const segments = 192;
  const angle = start.angleTo(end);
  const points: THREE.Vector3[] = [];
  const sinAngle = Math.sin(angle);
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    let p: THREE.Vector3;
    if (sinAngle < 1e-6) {
      p = start.clone().lerp(end, t);
    } else {
      const s1 = Math.sin((1 - t) * angle) / sinAngle;
      const s2 = Math.sin(t * angle) / sinAngle;
      p = start.clone().multiplyScalar(s1).add(end.clone().multiplyScalar(s2));
    }
    p.normalize().multiplyScalar(EARTH_RADIUS * SURFACE_OFFSET);
    points.push(p);
  }

  globe.routeGroup.add(tagLayer(buildTube(points, tubeRadius, color), layer));
  return points[Math.floor(points.length / 2)];
}

export function drawMarker(
  globe: Globe,
  p: { lat: number; lon: number },
  color = 0xffcc66,
  layer = 'markers',
  size = 0.018,
  altitudeOffset = 0,
): void {
  const pos = latLonToVec3(p.lat, p.lon, EARTH_RADIUS * (SURFACE_OFFSET + altitudeOffset));
  const geo = new THREE.SphereGeometry(size, 16, 16);
  const mat = new THREE.MeshBasicMaterial({ color });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.copy(pos);
  globe.routeGroup.add(tagLayer(mesh, layer));
}

/** Draw an actual flown track / filed route as a surface-hugging tube. */
export function drawTrack(
  globe: Globe,
  points: Array<{ lat: number; lon: number }>,
  color = 0xff6b9a,
  layer = 'track',
  altitudeOffset = 0,
  tubeRadius = 0.005,
): void {
  if (points.length < 2) return;
  const radius = EARTH_RADIUS * (SURFACE_OFFSET + 0.004 + altitudeOffset);
  const verts = densifyOnSphere(points, radius);
  if (verts.length < 2) return;
  globe.routeGroup.add(tagLayer(buildTube(verts, tubeRadius, color), layer));
}

/**
 * Draw a small aircraft silhouette at the last point of `points`, oriented
 * along the heading from the second-to-last point. Tagged as the 'aircraft'
 * layer (which shares visibility with the 'track' layer).
 */
export function drawAircraft(
  globe: Globe,
  points: Array<{ lat: number; lon: number }>,
  color = 0xffe066,
  layer = 'aircraft',
): void {
  if (points.length < 1) return;
  const last = points[points.length - 1];
  const prev = points.length >= 2 ? points[points.length - 2] : null;

  const radius = EARTH_RADIUS * (SURFACE_OFFSET + 0.004 + 0.012);
  const pos = latLonToVec3(last.lat, last.lon, radius);
  const up = pos.clone().normalize();

  let forward: THREE.Vector3;
  if (prev) {
    const a = latLonToVec3(prev.lat, prev.lon).normalize();
    const dir = up.clone().sub(a);
    forward = dir.sub(up.clone().multiplyScalar(dir.dot(up)));
    if (forward.lengthSq() < 1e-9) forward = new THREE.Vector3(0, 1, 0);
    forward.normalize();
  } else {
    forward = new THREE.Vector3().crossVectors(up, new THREE.Vector3(0, 1, 0));
    if (forward.lengthSq() < 1e-9) {
      forward = new THREE.Vector3().crossVectors(up, new THREE.Vector3(1, 0, 0));
    }
    forward.normalize();
  }
  const right = new THREE.Vector3().crossVectors(forward, up).normalize();

  const mesh = buildAircraftMesh(color);
  const basis = new THREE.Matrix4().makeBasis(right, forward, up);
  mesh.quaternion.setFromRotationMatrix(basis);
  mesh.position.copy(pos);
  globe.routeGroup.add(tagLayer(mesh, layer));
}

function buildAircraftMesh(color: number): THREE.Mesh {
  const shape = new THREE.Shape();
  shape.moveTo(0, 1.0);
  shape.lineTo(0.07, 0.15);
  shape.lineTo(0.95, -0.08);
  shape.lineTo(0.95, -0.22);
  shape.lineTo(0.08, -0.32);
  shape.lineTo(0.30, -0.78);
  shape.lineTo(0.30, -0.92);
  shape.lineTo(0.03, -0.78);
  shape.lineTo(0, -0.95);
  shape.lineTo(-0.03, -0.78);
  shape.lineTo(-0.30, -0.92);
  shape.lineTo(-0.30, -0.78);
  shape.lineTo(-0.08, -0.32);
  shape.lineTo(-0.95, -0.22);
  shape.lineTo(-0.95, -0.08);
  shape.lineTo(-0.07, 0.15);
  shape.lineTo(0, 1.0);
  const geo = new THREE.ShapeGeometry(shape);
  geo.scale(0.025, 0.025, 0.025);
  // Centre the shape so the geometric origin sits roughly on the aircraft body.
  geo.translate(0, -0.0025, 0);
  const mat = new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide });
  return new THREE.Mesh(geo, mat);
}

function disposeObject(obj: THREE.Object3D): void {
  obj.traverse((c) => {
    const mesh = c as THREE.Mesh & { material?: THREE.Material | THREE.Material[] };
    if ((mesh as THREE.Mesh).geometry) (mesh as THREE.Mesh).geometry.dispose();
    if (mesh.material) {
      if (Array.isArray(mesh.material)) mesh.material.forEach((m) => m.dispose());
      else mesh.material.dispose();
    }
  });
}
