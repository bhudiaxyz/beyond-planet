import * as THREE from 'three';
import { combineSeed, SeededRandom } from '../utils/Random';
import { CAVES, WORLD } from '../config';
import { WorldPalette } from '../settings/Palette';
import { Noise2D } from '../procedural/Noise';
import type { Terrain } from './Terrain';
import type { Biomes } from './Biomes';
import type { Interactables } from './Interactables';
import { buildCaveGlow } from './Glow';
import type { SharedEnvUniforms } from './Environment';

export interface CaveContext {
  floor: number;
  ceiling: number;
}

export interface ArcSample {
  point: THREE.Vector3;
  tangent: THREE.Vector3;
  normal: THREE.Vector3;
  binormal: THREE.Vector3;
  radius: number;
}

export interface CaveInstance {
  id: number;
  entranceX: number;
  entranceZ: number;
  biomeType: 'shore' | 'grassland' | 'mountain';
  controlPoints: THREE.Vector3[];
  arcSamples: ArcSample[] | null;  // null until first use
  group: THREE.Group | null;
}

function buildTubeGeometry(samples: ArcSample[], displaceNoise: Noise2D, radialSegs: number): THREE.BufferGeometry {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  const sliceCount = samples.length - 1;
  const vertsPerSlice = radialSegs + 1;

  for (let i = 0; i <= sliceCount; i++) {
    const s = samples[i];
    const u = i / sliceCount;
    for (let j = 0; j <= radialSegs; j++) {
      const angle = (j / radialSegs) * Math.PI * 2;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const disp = displaceNoise.fbm(u * 8.5, angle * 0.8, 2) * 0.35;
      const r = s.radius + disp;
      positions.push(
        s.point.x + r * (cos * s.normal.x + sin * s.binormal.x),
        s.point.y + r * (cos * s.normal.y + sin * s.binormal.y),
        s.point.z + r * (cos * s.normal.z + sin * s.binormal.z),
      );
      uvs.push(j / radialSegs, u * 4);
    }
  }

  for (let i = 0; i < sliceCount; i++) {
    for (let j = 0; j < radialSegs; j++) {
      const a = i * vertsPerSlice + j;
      const b = a + 1;
      const c = a + vertsPerSlice;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

function buildEntranceArch(sample: ArcSample): THREE.BufferGeometry {
  const archGeo = new THREE.TorusGeometry(sample.radius * 0.9, 0.45, 6, 12, Math.PI);
  archGeo.applyQuaternion(
    new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), sample.tangent),
  );
  archGeo.translate(sample.point.x, sample.point.y, sample.point.z);
  return archGeo;
}

function buildArcTable(controlPoints: THREE.Vector3[]): ArcSample[] {
  const curve = new THREE.CatmullRomCurve3(controlPoints, false, 'catmullrom', 0.5);
  const samples: ArcSample[] = [];

  let prevNorm = new THREE.Vector3(0, 1, 0);
  const tangent = new THREE.Vector3();
  const binormal = new THREE.Vector3();
  const normal = new THREE.Vector3();

  for (let i = 0; i <= CAVES.arcSlices; i++) {
    const u = i / CAVES.arcSlices;
    const point = curve.getPointAt(u);
    curve.getTangentAt(u, tangent).normalize();

    binormal.crossVectors(tangent, prevNorm).normalize();
    normal.crossVectors(binormal, tangent).normalize();
    prevNorm.copy(normal);

    // Radius profile: entrance narrows → passage → chamber expands.
    let radius: number;
    if (u < CAVES.entranceFrac)
      radius = THREE.MathUtils.lerp(CAVES.entranceRadiusStart, CAVES.entranceRadiusEnd, u / CAVES.entranceFrac);
    else if (u < CAVES.chamberStartFrac)
      radius = THREE.MathUtils.lerp(CAVES.entranceRadiusEnd, CAVES.passageRadiusEnd, (u - CAVES.entranceFrac) / (CAVES.chamberStartFrac - CAVES.entranceFrac));
    else
      radius = THREE.MathUtils.lerp(CAVES.passageRadiusEnd, CAVES.chamberRadius, (u - CAVES.chamberStartFrac) / (1 - CAVES.chamberStartFrac));

    samples.push({
      point: point.clone(),
      tangent: tangent.clone(),
      normal: normal.clone(),
      binormal: binormal.clone(),
      radius,
    });
  }
  return samples;
}

/** Single fern frond: a tapered flat quad. */
function buildFrondGeometry(len: number, width: number): THREE.BufferGeometry {
  const geo = new THREE.PlaneGeometry(width, len, 1, 3);
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const t = (pos.getY(i) / len + 0.5);
    pos.setZ(i, t * t * 0.3);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

export function buildCaveFlora(
  group: THREE.Group,
  cave: CaveInstance,
  rng: SeededRandom,
  fernMat: THREE.MeshLambertMaterial,
  ghostFlowerMat: THREE.MeshLambertMaterial,
  mossMat: THREE.MeshLambertMaterial,
): void {
  if (!cave.arcSamples) return;
  const samples = cave.arcSamples;
  const sliceCount = samples.length - 1;
  const floraEnd = Math.floor(sliceCount * 0.55);

  // ── Pale ferns ─────────────────────────────────────────────────────────
  const fernCount = rng.int(CAVES.fernCountMin, CAVES.fernCountMax);
  for (let f = 0; f < fernCount; f++) {
    const si = rng.int(0, floraEnd);
    const s = samples[si];
    const fernGroup = new THREE.Group();
    const fronds = rng.int(CAVES.fernFrondMin, CAVES.fernFrondMax);
    for (let fr = 0; fr < fronds; fr++) {
      const frondGeo = buildFrondGeometry(rng.range(0.3, 0.55), 0.08);
      frondGeo.userData.ownsGeometry = true;
      const frondMesh = new THREE.Mesh(frondGeo, fernMat);
      frondMesh.rotation.y = (fr / fronds) * Math.PI * 2 + rng.range(-0.2, 0.2);
      frondMesh.rotation.z = rng.range(0.2, 0.55);
      fernGroup.add(frondMesh);
    }
    const fAngle = Math.PI * 0.5;
    const r = s.radius * rng.range(0.3, 0.7);
    fernGroup.position.set(
      s.point.x + r * (Math.cos(fAngle) * s.normal.x + Math.sin(fAngle) * s.binormal.x),
      s.point.y + r * (Math.cos(fAngle) * s.normal.y + Math.sin(fAngle) * s.binormal.y),
      s.point.z + r * (Math.cos(fAngle) * s.normal.z + Math.sin(fAngle) * s.binormal.z),
    );
    fernGroup.scale.setScalar(rng.range(0.4, 0.8));
    group.add(fernGroup);
  }

  // ── Ghost flowers ───────────────────────────────────────────────────────
  const ghostCount = rng.int(CAVES.ghostCountMin, CAVES.ghostCountMax);
  for (let g = 0; g < ghostCount; g++) {
    const si = rng.int(Math.floor(floraEnd * 0.3), floraEnd);
    const s = samples[si];
    const flowerGroup = new THREE.Group();
    const stemGeo = new THREE.CylinderGeometry(0.012, 0.018, 0.25, 5);
    stemGeo.userData.ownsGeometry = true;
    flowerGroup.add(new THREE.Mesh(stemGeo, ghostFlowerMat));
    for (let p = 0; p < 4; p++) {
      const petalGeo = new THREE.PlaneGeometry(0.08, 0.12);
      petalGeo.userData.ownsGeometry = true;
      const petal = new THREE.Mesh(petalGeo, ghostFlowerMat);
      petal.position.y = 0.24;
      petal.rotation.y = (p / 4) * Math.PI * 2;
      petal.rotation.x = 0.4;
      flowerGroup.add(petal);
    }
    const fAngle = Math.PI * 0.5;
    const r = s.radius * rng.range(0.2, 0.65);
    flowerGroup.position.set(
      s.point.x + r * (Math.cos(fAngle) * s.normal.x + Math.sin(fAngle) * s.binormal.x),
      s.point.y + r * (Math.cos(fAngle) * s.normal.y + Math.sin(fAngle) * s.binormal.y),
      s.point.z + r * (Math.cos(fAngle) * s.normal.z + Math.sin(fAngle) * s.binormal.z),
    );
    flowerGroup.scale.setScalar(rng.range(0.5, 1.0));
    group.add(flowerGroup);
  }

  // ── Cave moss patches ───────────────────────────────────────────────────
  const mossCount = rng.int(CAVES.mossCountMin, CAVES.mossCountMax);
  for (let m = 0; m < mossCount; m++) {
    const si = rng.int(0, sliceCount - 1);
    const s = samples[si];
    const mossGeo = new THREE.CircleGeometry(rng.range(0.28, 0.75), 10);
    mossGeo.userData.ownsGeometry = true;
    mossGeo.scale(1, 0.06, 1);
    const mossMesh = new THREE.Mesh(mossGeo, mossMat);
    const fAngle = Math.PI * 0.5;
    const r = s.radius * rng.range(0.1, 0.75);
    mossMesh.position.set(
      s.point.x + r * (Math.cos(fAngle) * s.normal.x + Math.sin(fAngle) * s.binormal.x),
      s.point.y + r * (Math.cos(fAngle) * s.normal.y + Math.sin(fAngle) * s.binormal.y),
      s.point.z + r * (Math.cos(fAngle) * s.normal.z + Math.sin(fAngle) * s.binormal.z),
    );
    mossMesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), s.binormal.clone().negate());
    group.add(mossMesh);
  }
}

export class CaveNetwork {
  private caves = new Map<string, CaveInstance>();

  // Shared materials — built once per world, never disposed per-chunk.
  private readonly matRock  = new THREE.MeshLambertMaterial({ color: WorldPalette.CAVE_ROCK.getHex(),  side: THREE.BackSide });
  private readonly matStal  = new THREE.MeshLambertMaterial({ color: WorldPalette.CAVE_ROCK.getHex() });
  private readonly matFern  = new THREE.MeshLambertMaterial({ color: WorldPalette.CAVE_FERN.getHex(),         side: THREE.DoubleSide, transparent: true, alphaTest: 0.35 });
  private readonly matGhost = new THREE.MeshLambertMaterial({ color: WorldPalette.CAVE_GHOST_FLOWER.getHex(), side: THREE.DoubleSide, transparent: true, alphaTest: 0.3  });
  private readonly matMoss  = new THREE.MeshLambertMaterial({ color: WorldPalette.CAVE_MOSS.getHex(),  side: THREE.DoubleSide });
  private readonly matPool  = new THREE.MeshLambertMaterial({ color: WorldPalette.CAVE_POOL.getHex(),  transparent: true, opacity: 0.82 });

  constructor(
    private readonly seed: number,
    private readonly terrain: Terrain,
    private readonly biomes: Biomes,
  ) {
    const regionCells = CAVES.regionCells;
    for (let cellX = -regionCells; cellX <= regionCells; cellX++) {
      for (let cellZ = -regionCells; cellZ <= regionCells; cellZ++) {
        const rng = new SeededRandom(combineSeed(this.seed, cellX, cellZ, 0xCA7E));
        if (!rng.chance(CAVES.spawnChance)) continue;
        const wx = (cellX + rng.range(-0.6, 0.6)) * CAVES.cellStep;
        const wz = (cellZ + rng.range(-0.6, 0.6)) * CAVES.cellStep;
        const cave = this.tryPlaceEntrance(wx, wz, cellX, cellZ, rng);
        if (cave) this.caves.set(`${cellX},${cellZ}`, cave);
      }
    }
  }

  private tryPlaceEntrance(
    wx: number, wz: number,
    cellX: number, cellZ: number,
    rng: SeededRandom,
  ): CaveInstance | null {
    const h = this.terrain.getHeightAt(wx, wz);
    const normal = new THREE.Vector3();
    this.terrain.getNormalAt(wx, wz, normal);
    if (h < WORLD.waterLevel + CAVES.minWaterClearance) return null;
    if (normal.y < CAVES.minSlopeNormal) return null;
    if (h > WORLD.treeLine + CAVES.highAltitudeBand && rng.chance(CAVES.highAltitudeRejectChance)) return null;

    void this.biomes.getMoisture(wx, wz); // reserved for future biome-specific rejection
    const biomeType: CaveInstance['biomeType'] =
      h < WORLD.waterLevel + CAVES.shoreBiomeHeight ? 'shore'
      : h > WORLD.treeLine - CAVES.mountainBiomeBuffer ? 'mountain'
      : 'grassland';

    const controlPoints = this.buildControlPoints(wx, wz, h, rng, biomeType);
    return {
      id: combineSeed(cellX, cellZ, 0xCA7E),
      entranceX: wx,
      entranceZ: wz,
      biomeType,
      controlPoints,
      arcSamples: null,
      group: null,
    };
  }

  private buildControlPoints(
    wx: number, wz: number, surfaceH: number,
    rng: SeededRandom,
    biomeType: CaveInstance['biomeType'],
  ): THREE.Vector3[] {
    void biomeType; // reserved for per-biome depth/length tuning

    const bearing = rng.range(0, Math.PI * 2);
    const cos = Math.cos(bearing);
    const sin = Math.sin(bearing);

    const points: THREE.Vector3[] = [];
    points.push(new THREE.Vector3(wx, surfaceH - 0.5, wz));

    const d1 = rng.range(8, 15);
    const x1 = wx + cos * d1;
    const z1 = wz + sin * d1;
    points.push(new THREE.Vector3(x1, surfaceH - rng.range(5, 10), z1));

    const bendCount = rng.chance(0.6) ? 2 : 1;
    let lastX = x1, lastZ = z1;
    for (let b = 0; b < bendCount; b++) {
      const segLen = rng.range(12, 22);
      const yaw = bearing + rng.range(-0.7, 0.7);
      const bx = lastX + Math.cos(yaw) * segLen;
      const bz = lastZ + Math.sin(yaw) * segLen;
      const bh = this.terrain.getHeightAt(bx, bz);
      const depth = rng.range(8, 20);
      points.push(new THREE.Vector3(bx, Math.min(bh - depth, surfaceH - depth), bz));
      lastX = bx; lastZ = bz;
    }

    const chamberDist = rng.range(15, 28);
    const chamberYaw = bearing + rng.range(-0.5, 0.5);
    const cx2 = lastX + Math.cos(chamberYaw) * chamberDist;
    const cz2 = lastZ + Math.sin(chamberYaw) * chamberDist;
    const chamberSurface = this.terrain.getHeightAt(cx2, cz2);
    points.push(new THREE.Vector3(cx2, Math.min(chamberSurface - rng.range(8, 25), surfaceH - 12), cz2));

    return points;
  }

  getArcSamples(cave: CaveInstance): ArcSample[] {
    if (!cave.arcSamples) cave.arcSamples = buildArcTable(cave.controlPoints);
    return cave.arcSamples;
  }

  buildTubeMesh(cave: CaveInstance, rng: SeededRandom): THREE.Group {
    void rng;
    const samples = this.getArcSamples(cave);
    const displaceNoise = new Noise2D(combineSeed(cave.id, 0xD15));

    const tubeGeo = buildTubeGeometry(samples, displaceNoise, CAVES.radialSegs);
    tubeGeo.userData.ownsGeometry = true;
    const tubeMesh = new THREE.Mesh(tubeGeo, this.matRock);
    tubeMesh.receiveShadow = false;
    tubeMesh.castShadow = false;

    const archGeo = buildEntranceArch(samples[0]);
    archGeo.userData.ownsGeometry = true;
    const archMesh = new THREE.Mesh(archGeo, this.matRock);

    const group = new THREE.Group();
    group.add(tubeMesh, archMesh);
    return group;
  }

  buildCaveDecor(group: THREE.Group, cave: CaveInstance, rng: SeededRandom): void {
    const samples = this.getArcSamples(cave);
    const sliceCount = samples.length - 1;

    // ── Stalactites (ceiling) ─────────────────────────────────────────────────
    const stalCount = rng.int(CAVES.stalCountMin, CAVES.stalCountMax);
    const stalGeo = new THREE.ConeGeometry(0.06, 1.0, 8, 1);
    stalGeo.userData.ownsGeometry = true;
    stalGeo.applyMatrix4(new THREE.Matrix4().makeRotationX(Math.PI));
    const stalMesh = new THREE.InstancedMesh(stalGeo, this.matStal, stalCount);
    stalMesh.count = 0;
    const mxS = new THREE.Matrix4();
    const scaleV = new THREE.Vector3();
    for (let k = 0; k < stalCount; k++) {
      const si = rng.int(2, sliceCount - 2);
      const s = samples[si];
      const angle = rng.range(-Math.PI * 0.65, Math.PI * 0.65);
      const cos = Math.cos(angle), sin = Math.sin(angle);
      const r = s.radius * 0.85;
      const px = s.point.x + r * (cos * s.normal.x + sin * s.binormal.x);
      const py = s.point.y + r * (cos * s.normal.y + sin * s.binormal.y);
      const pz = s.point.z + r * (cos * s.normal.z + sin * s.binormal.z);
      const h = rng.range(0.3, 2.2);
      scaleV.set(rng.range(0.8, 1.4), h, rng.range(0.8, 1.4));
      mxS.compose(new THREE.Vector3(px, py, pz), new THREE.Quaternion(), scaleV);
      stalMesh.setMatrixAt(stalMesh.count++, mxS);
    }
    stalMesh.instanceMatrix.needsUpdate = true;
    group.add(stalMesh);

    // ── Stalagmites (floor) ───────────────────────────────────────────────────
    const miteCount = rng.int(CAVES.miteCountMin, CAVES.miteCountMax);
    const miteGeo = new THREE.ConeGeometry(0.06, 1.0, 8, 1);
    miteGeo.userData.ownsGeometry = true;
    const miteMesh = new THREE.InstancedMesh(miteGeo, this.matStal, miteCount);
    miteMesh.count = 0;
    for (let k = 0; k < miteCount; k++) {
      const si = rng.int(4, sliceCount - 1);
      const s = samples[si];
      const angle = rng.range(Math.PI * 0.35, Math.PI * 0.65);
      const cos = Math.cos(angle), sin = Math.sin(angle);
      const r = s.radius * 0.75;
      const px = s.point.x + r * (cos * s.normal.x + sin * s.binormal.x);
      const py = s.point.y + r * (cos * s.normal.y + sin * s.binormal.y);
      const pz = s.point.z + r * (cos * s.normal.z + sin * s.binormal.z);
      const h = rng.range(0.2, 1.8);
      scaleV.set(rng.range(0.8, 1.3), h, rng.range(0.8, 1.3));
      mxS.compose(new THREE.Vector3(px, py, pz), new THREE.Quaternion(), scaleV);
      miteMesh.setMatrixAt(miteMesh.count++, mxS);
    }
    miteMesh.instanceMatrix.needsUpdate = true;
    group.add(miteMesh);

    // ── Crystal clusters (chamber — last portion of arc) ──────────────────────
    const hue = WorldPalette.CAVE_CRYSTAL[cave.biomeType];
    const crystalMat = new THREE.MeshStandardMaterial({
      color: hue,
      emissive: hue,
      emissiveIntensity: CAVES.crystalEmissiveIntensity,
      roughness: 0.2,
      metalness: 0.1,
    });
    const chamberStart = Math.floor(sliceCount * CAVES.chamberStartFrac);
    const clusterCount = rng.int(CAVES.clusterCountMin, CAVES.clusterCountMax);
    for (let c = 0; c < clusterCount; c++) {
      const si = rng.int(chamberStart, sliceCount - 1);
      const s = samples[si];
      const clusterGroup = new THREE.Group();
      const spikeCount = rng.int(2, 5);
      for (let sp = 0; sp < spikeCount; sp++) {
        const h = rng.range(0.4, 1.3);
        const spikeGeo = new THREE.CylinderGeometry(0.04, 0.28, h, 6, 1);
        spikeGeo.userData.ownsGeometry = true;
        const spikeMesh = new THREE.Mesh(spikeGeo, crystalMat);
        spikeMesh.position.set(rng.range(-0.4, 0.4), h * 0.5, rng.range(-0.4, 0.4));
        spikeMesh.rotation.set(rng.range(-0.3, 0.3), rng.range(0, Math.PI * 2), rng.range(-0.3, 0.3));
        clusterGroup.add(spikeMesh);
      }
      const floorAngle = Math.PI * 0.5;
      const r = s.radius * 0.55 * rng.range(0.3, 0.9);
      clusterGroup.position.set(
        s.point.x + r * (Math.cos(floorAngle) * s.normal.x + Math.sin(floorAngle) * s.binormal.x),
        s.point.y + r * (Math.cos(floorAngle) * s.normal.y + Math.sin(floorAngle) * s.binormal.y),
        s.point.z + r * (Math.cos(floorAngle) * s.normal.z + Math.sin(floorAngle) * s.binormal.z),
      );
      if (c < 2) {
        const light = new THREE.PointLight(hue.getHex(), CAVES.crystalLightIntensity, CAVES.crystalLightDistance, CAVES.crystalLightDecay);
        light.position.copy(clusterGroup.position);
        group.add(light);
      }
      group.add(clusterGroup);
    }

    // ── Entrance PointLight ────────────────────────────────────────────────────
    const entranceLight = new THREE.PointLight(WorldPalette.CAVE_ENTRANCE_GLOW.getHex(), CAVES.entranceLightIntensity, CAVES.entranceLightDistance, CAVES.entranceLightDecay);
    entranceLight.position.copy(samples[0].point);
    group.add(entranceLight);

    // ── Drip pools ────────────────────────────────────────────────────────────
    const poolCount = rng.int(3, 7);
    for (let p = 0; p < poolCount; p++) {
      const si = rng.int(4, sliceCount - 1);
      const s = samples[si];
      const poolGeo = new THREE.CircleGeometry(rng.range(0.4, 1.1), 12);
      poolGeo.userData.ownsGeometry = true;
      const poolMesh = new THREE.Mesh(poolGeo, this.matPool);
      const fAngle = Math.PI * 0.5;
      poolMesh.position.set(
        s.point.x + s.radius * 0.6 * (Math.cos(fAngle) * s.normal.x + Math.sin(fAngle) * s.binormal.x),
        s.point.y + s.radius * 0.6 * (Math.cos(fAngle) * s.normal.y + Math.sin(fAngle) * s.binormal.y),
        s.point.z + s.radius * 0.6 * (Math.cos(fAngle) * s.normal.z + Math.sin(fAngle) * s.binormal.z),
      );
      poolMesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), s.normal.clone().negate());
      group.add(poolMesh);
    }
  }

  getCaveContext(x: number, y: number, z: number): CaveContext | null {
    for (const cave of this.caves.values()) {
      if (!cave.arcSamples) continue;
      const samples = cave.arcSamples;
      let closestDist = Infinity;
      let closestIdx = 0;
      for (let i = 0; i < samples.length; i++) {
        const s = samples[i];
        const dx = x - s.point.x, dz = z - s.point.z;
        const d = dx * dx + dz * dz;
        if (d < closestDist) { closestDist = d; closestIdx = i; }
      }
      const s = samples[closestIdx];
      const margin = s.radius * CAVES.marginFactor;
      if (closestDist > margin * margin) continue;

      const floor = s.point.y - s.radius * CAVES.floorFactor;
      const ceiling = s.point.y + s.radius * CAVES.ceilingFactor;

      const surfaceH = this.terrain.getHeightAt(x, z);
      if (y > surfaceH + 0.5) continue;

      return { floor, ceiling };
    }
    return null;
  }

  getWallColliders(cave: CaveInstance): Array<{ x: number; z: number; radius: number }> {
    if (!cave.arcSamples) return [];
    return cave.arcSamples
      .filter((_, i) => i % 4 === 0)
      .map(s => ({ x: s.point.x, z: s.point.z, radius: s.radius }));
  }

  getCavesForChunk(cx: number, cz: number): CaveInstance[] {
    const result: CaveInstance[] = [];
    for (const cave of this.caves.values()) {
      const ecx = Math.floor(cave.entranceX / WORLD.chunkSize);
      const ecz = Math.floor(cave.entranceZ / WORLD.chunkSize);
      if (Math.abs(ecx - cx) <= 1 && Math.abs(ecz - cz) <= 1) result.push(cave);
    }
    return result;
  }

  releaseChunk(cx: number, cz: number): void {
    for (const cave of this.getCavesForChunk(cx, cz)) {
      cave.group = null;
    }
  }

  /**
   * Builds cave geometry for any cave whose entrance is in or adjacent to
   * chunk (cx, cz). Returns wall cylinder colliders for all built caves so
   * ChunkManager can push them into staticColliders.
   */
  maybeBuildForChunk(
    cx: number,
    cz: number,
    group: THREE.Group,
    interactables: Interactables,
    env: SharedEnvUniforms,
  ): Array<{ x: number; z: number; radius: number }> {
    const colliders: Array<{ x: number; z: number; radius: number }> = [];
    const candidates = this.getCavesForChunk(cx, cz);
    for (const cave of candidates) {
      if (cave.group) {
        // Already built — still expose its wall colliders for this chunk.
        colliders.push(...this.getWallColliders(cave));
        continue;
      }
      const rng = new SeededRandom(combineSeed(this.seed, cave.id, 0xB01D));
      this.getArcSamples(cave);

      const caveGroup = this.buildTubeMesh(cave, rng);
      this.buildCaveDecor(caveGroup, cave, rng);
      buildCaveFlora(caveGroup, cave, rng, this.matFern, this.matGhost, this.matMoss);
      this.placeCaveInteractable(caveGroup, cave, rng, interactables);
      buildCaveGlow(caveGroup, cave.arcSamples!, rng, env);

      cave.group = caveGroup;
      group.add(caveGroup);
      colliders.push(...this.getWallColliders(cave));
    }
    return colliders;
  }

  placeCaveInteractable(
    group: THREE.Group,
    cave: CaveInstance,
    rng: SeededRandom,
    interactables: Interactables,
  ): void {
    const samples = cave.arcSamples;
    if (!samples || samples.length === 0) return;
    const chamberSample = samples[samples.length - 1];
    const kindIndex = rng.int(0, 2);
    const kind = (['cave_crystal', 'cave_inscription', 'cave_bones'] as const)[kindIndex];
    const interactable = interactables.buildKind(kind, rng, chamberSample.point.clone());
    if (interactable) group.add(interactable.object);
  }
}
