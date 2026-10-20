/**
 * Sward — ground-grass blade geometry.
 *
 * A single blade is a tapered, pre-bent strip with rounded normals so it
 * catches light like a real leaf. Several blades are pre-baked into one tuft so
 * a walking-distance lawn reads as continuous cover without spawning millions
 * of instances. These geometries are shared; the streamer just instances them.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/** One four-segment blade, tapered and bent forward, with soft side normals. */
export function bladeStrip(segments = 4): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const baseWidth = 0.023;
  const sideN = 0.616;
  const backN = 0.788;

  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const w = baseWidth * (1 - t * 0.85);
    const bend = t * t * 0.28;
    const y = t * (1 - t * t * 0.06);
    if (i < segments) {
      positions.push(-w, y, bend, w, y, bend);
      normals.push(-sideN, 0.25, -backN, sideN, 0.25, -backN);
      uvs.push(0, t, 1, t);
    } else {
      positions.push(0, y, bend);
      normals.push(0, 0.25, -1);
      uvs.push(0.5, 1);
    }
  }
  for (let i = 0; i < segments; i++) {
    const a = i * 2;
    if (i < segments - 1) indices.push(a, a + 1, a + 3, a, a + 3, a + 2);
    else indices.push(a, a + 1, a + 2);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  return geo;
}

/** Merge `blades` jittered reference blades into one instanceable tuft. */
export function bladeTuft(blades = 5, segments = 4): THREE.BufferGeometry {
  // self-contained LCG so a tuft is reproducible without touching the world RNG
  let state = 1234567 + blades * 77 + segments * 13;
  const rand = (): number => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
  const parts: THREE.BufferGeometry[] = [];

  for (let b = 0; b < blades; b++) {
    const blade = bladeStrip(segments);
    const yaw = rand() * Math.PI * 2;
    const tall = 0.82 + rand() * 0.78;
    const lean = (rand() - 0.5) * 0.42;
    const ox = (rand() - 0.5) * 0.56;
    const oz = (rand() - 0.5) * 0.56;
    const pos = blade.getAttribute('position') as THREE.BufferAttribute;
    const nrm = blade.getAttribute('normal') as THREE.BufferAttribute;
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i) * 1.45;
      const y = pos.getY(i) * tall;
      const z = pos.getZ(i);
      pos.setXYZ(i, x * c + z * s + ox + lean * y * c, y, z * c - x * s + oz + lean * y * s);
      const nx = nrm.getX(i);
      const nz = nrm.getZ(i);
      nrm.setXYZ(i, nx * c + nz * s, nrm.getY(i), nz * c - nx * s);
    }
    parts.push(blade);
  }

  return mergeGeometries(parts)!;
}

// ─── Reed geometry ────────────────────────────────────────────────────────────

function reedStalk(segments = 6): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    // Cattail-style seed head: bulge between 75 – 95% then taper to tip.
    const bulge = t > 0.75 && t < 0.95 ? Math.sin(((t - 0.75) / 0.2) * Math.PI) * 0.7 : 0;
    const w = 0.013 * (1 - t * 0.3 + bulge);
    const bend = t * t * 0.05;
    const y = t;
    if (i < segments) {
      positions.push(-w, y, bend, w, y, bend);
      normals.push(-0.6, 0.1, -0.8, 0.6, 0.1, -0.8);
      uvs.push(0, t, 1, t);
    } else {
      positions.push(0, y, bend);
      normals.push(0, 0, -1);
      uvs.push(0.5, 1);
    }
  }
  for (let i = 0; i < segments; i++) {
    const a = i * 2;
    if (i < segments - 1) indices.push(a, a + 1, a + 3, a, a + 3, a + 2);
    else indices.push(a, a + 1, a + 2);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  return geo;
}

/** Tight clump of reed stalks for wetland / shoreline areas. One instance = one clump. */
export function reedTuft(stalks = 4, segments = 6): THREE.BufferGeometry {
  let state = 9876543 + stalks * 53 + segments * 17;
  const rand = (): number => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
  const parts: THREE.BufferGeometry[] = [];
  for (let b = 0; b < stalks; b++) {
    const stalk = reedStalk(segments);
    const yaw = rand() * Math.PI * 2;
    const tall = 0.75 + rand() * 0.65;
    const lean = (rand() - 0.5) * 0.15;
    const ox = (rand() - 0.5) * 0.28;
    const oz = (rand() - 0.5) * 0.28;
    const pos = stalk.getAttribute('position') as THREE.BufferAttribute;
    const nrm = stalk.getAttribute('normal') as THREE.BufferAttribute;
    const c = Math.cos(yaw), s = Math.sin(yaw);
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i) * tall;
      const z = pos.getZ(i);
      pos.setXYZ(i, x * c + z * s + ox + lean * y * c, y, z * c - x * s + oz + lean * y * s);
      const nx = nrm.getX(i), nz = nrm.getZ(i);
      nrm.setXYZ(i, nx * c + nz * s, nrm.getY(i), nz * c - nx * s);
    }
    parts.push(stalk);
  }
  return mergeGeometries(parts)!;
}

// ─── Cactus geometry ──────────────────────────────────────────────────────────

/** Upright quad strip rotated about Y by `rotY` radians — one face of the trunk cross. */
function cactusStrip(segments: number, halfW: number, height: number, rotY: number): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const c = Math.cos(rotY), s = Math.sin(rotY);
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const w = halfW * (1 - t * 0.1);
    const y = t * height;
    if (i < segments) {
      positions.push(-w * c, y, w * s, w * c, y, -w * s);
      normals.push(-c * 0.5, 0.15, s * 0.5, c * 0.5, 0.15, -s * 0.5);
      uvs.push(0, t, 1, t);
    } else {
      positions.push(0, y, 0);
      normals.push(0, 1, 0);
      uvs.push(0.5, 1);
    }
  }
  for (let i = 0; i < segments; i++) {
    const a = i * 2;
    if (i < segments - 1) indices.push(a, a + 1, a + 3, a, a + 3, a + 2);
    else indices.push(a, a + 1, a + 2);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  return geo;
}

/** Flat tapered quad for a cactus arm extending to `side` (±1) from the trunk. */
function cactusArmQuad(side: 1 | -1, baseH: number): THREE.BufferGeometry {
  const startX = 0.07 * side;
  const endX = 0.37 * side;
  const endY = baseH + 0.28;
  const aw = 0.04;
  const positions = [
    startX, baseH - aw, 0, startX, baseH + aw, 0,
    endX,   endY + aw * 0.4, 0, endX,   endY - aw * 0.4, 0,
  ];
  const normals = [0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1];
  const uvs = [0, 0, 0, 1, 1, 1, 1, 0];
  const indices = [0, 1, 2, 0, 2, 3];
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  return geo;
}

/**
 * Cross-shaped cactus trunk (visible from all sides) with two stubby arm stubs.
 * One instance = one cactus; random yaw per instance varies arm orientation.
 */
export function cactusCluster(lod = 0): THREE.BufferGeometry {
  const segs = lod >= 2 ? 2 : 3;
  const parts: THREE.BufferGeometry[] = [
    cactusStrip(segs, 0.08, 1.0, 0),
    cactusStrip(segs, 0.08, 1.0, Math.PI / 2),
  ];
  if (lod < 2) {
    parts.push(cactusArmQuad(1, 0.60), cactusArmQuad(-1, 0.68));
  }
  return mergeGeometries(parts)!;
}
