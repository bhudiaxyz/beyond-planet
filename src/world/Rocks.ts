import * as THREE from 'three';
import { mergeVertices, mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { SeededRandom, combineSeed } from '../utils/Random';
import { Noise2D } from '../procedural/Noise';
import { WORLD, PROPS, type QualitySettings } from '../config';
import type { MaterialLibrary } from '../procedural/Materials';
import type { Terrain, HeightField } from './Terrain';
import type { Biomes } from './Biomes';
import type { CylinderCollider } from '../core/CameraController';

/**
 * Clone a MeshStandardMaterial and inject a uLodAlpha Bayer-dither discard.
 * Chains any existing onBeforeCompile (e.g. moss blend) so the rock shader
 * still works correctly; the Bayer discard runs in the same main() block.
 */
function withLodAlpha(mat: THREE.MeshStandardMaterial): THREE.Material {
  const m = mat.clone();
  const prev = m.onBeforeCompile;
  m.onBeforeCompile = (shader, renderer) => {
    if (prev) prev.call(m, shader, renderer);
    shader.fragmentShader =
      'uniform float uLodAlpha;\n' +
      'const float BAYER[16] = float[16](0.0/16.0,8.0/16.0,2.0/16.0,10.0/16.0,12.0/16.0,4.0/16.0,14.0/16.0,6.0/16.0,3.0/16.0,11.0/16.0,1.0/16.0,9.0/16.0,15.0/16.0,7.0/16.0,13.0/16.0,5.0/16.0);\n' +
      shader.fragmentShader.replace(
        'void main() {',
        'void main() {\n  float _b=BAYER[int(mod(gl_FragCoord.x,4.0))*4+int(mod(gl_FragCoord.y,4.0))];\n  if(uLodAlpha<_b+0.001)discard;\n'
      );
    shader.uniforms['uLodAlpha'] = { value: 1.0 };
    m.userData.shaderUniforms = shader.uniforms;
  };
  m.customProgramCacheKey = () => `${mat.customProgramCacheKey?.() ?? mat.uuid}-lod`;
  return m;
}

/**
 * Landscape props: boulders, small stones, fallen logs, shrubs, and flowers.
 * Template geometries are built once; chunks place them with InstancedMesh.
 */
export class Props {
  private boulderGeos: THREE.BufferGeometry[] = [];
  private stoneGeo: THREE.BufferGeometry;
  private logGeo: THREE.BufferGeometry;
  private seed: number;

  constructor(seed: number, private materials: MaterialLibrary, private quality: QualitySettings) {
    this.seed = seed;
    const rng = new SeededRandom(combineSeed(seed, 401));
    const noise = new Noise2D(combineSeed(seed, 402));

    // Bakes upward-facing weight into a vertex attribute; Task 7 multiplies by moisture uniform.
    const addMossBlend = (geo: THREE.BufferGeometry) => {
      const normalAttr = geo.getAttribute('normal') as THREE.BufferAttribute;
      const moss = new Float32Array(normalAttr.count);
      for (let i = 0; i < normalAttr.count; i++) {
        const ny = normalAttr.getY(i);
        moss[i] = Math.max(0, ny) ** 2;
      }
      geo.setAttribute('aMossBlend', new THREE.BufferAttribute(moss, 1));
    };

    // Boulders: icosahedra displaced by noise -> rugged but smooth-shaded.
    for (let v = 0; v < 3; v++) {
      // Weld vertices so displaced boulders get smooth normals, not facets.
      const geo = mergeVertices(new THREE.IcosahedronGeometry(1, 2), 1e-4);
      const pos = geo.getAttribute('position') as THREE.BufferAttribute;
      const stretch = { x: rng.range(0.8, 1.4), y: rng.range(0.6, 1.0), z: rng.range(0.8, 1.4) };
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i);
        const y = pos.getY(i);
        const z = pos.getZ(i);
        const n = noise.fbm(x * 1.4 + v * 19, (y + z) * 1.4 - v * 7, 3);
        const d = 1 + n * 0.35;
        pos.setXYZ(i, x * d * stretch.x, y * d * stretch.y, z * d * stretch.z);
      }
      geo.computeVertexNormals();
      addMossBlend(geo);
      this.boulderGeos.push(geo);
    }

    // Variant 3: slab — flattened tabletop rock.
    {
      const geo = mergeVertices(new THREE.IcosahedronGeometry(1.0, 2), 1e-4);
      const pos = geo.getAttribute('position') as THREE.BufferAttribute;
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
        const len = Math.sqrt(x * x + y * y + z * z) || 1;
        const disp = noise.fbm((x / len) * 3.1 + 31, (z / len) * 3.1 - 13, 3) * 0.28;
        pos.setXYZ(i, x * (1 + disp * 0.5), y * 0.22 + disp * 0.08, z * (1 + disp * 0.5));
      }
      pos.needsUpdate = true;
      geo.computeVertexNormals();
      addMossBlend(geo);
      this.boulderGeos.push(geo);
    }

    // Variant 4: angular cluster — two small boulders merged into one draw call.
    {
      const subGeos: THREE.BufferGeometry[] = [];
      for (let k = 0; k < 2; k++) {
        const sub = mergeVertices(new THREE.IcosahedronGeometry(0.55 + rng.range(0, 0.35), 1), 1e-4);
        const subPos = sub.getAttribute('position') as THREE.BufferAttribute;
        const offsetX = (k === 0 ? -0.35 : 0.35) + rng.range(-0.1, 0.1);
        const offsetZ = rng.range(-0.2, 0.2);
        const rotY = rng.range(0, Math.PI * 2);
        const cosR = Math.cos(rotY), sinR = Math.sin(rotY);
        for (let i = 0; i < subPos.count; i++) {
          const x = subPos.getX(i), y = subPos.getY(i), z = subPos.getZ(i);
          const disp = noise.fbm(x * 4 + k * 7, z * 4, 2) * 0.22;
          const rx = x * cosR - z * sinR;
          const rz = x * sinR + z * cosR;
          subPos.setXYZ(i, rx * (1 + disp) + offsetX, y * (0.7 + disp * 0.3), rz * (1 + disp) + offsetZ);
        }
        subPos.needsUpdate = true;
        sub.computeVertexNormals();
        subGeos.push(sub);
      }
      const merged = mergeGeometries(subGeos, false) ?? subGeos[0];
      addMossBlend(merged);
      this.boulderGeos.push(merged);
    }

    // Small stones: rough low-poly pebbles.
    const stone = new THREE.IcosahedronGeometry(1, 0);
    stone.scale(1.2, 0.7, 1);
    this.stoneGeo = stone;

    // Fallen log: lying tapered cylinder.
    const log = new THREE.CylinderGeometry(PROPS.logRadiusTop, PROPS.logRadiusBottom, PROPS.logLength, 7, 1);
    log.rotateZ(Math.PI / 2);
    log.translate(0, 0.16, 0);
    this.logGeo = log;

  }

  /**
   * Boulders exist out to a wider radius than the small props (they read
   * from far away); `includeSmallProps` toggles stones/logs/shrubs/flowers.
   */
  buildProps(
    cx: number,
    cz: number,
    terrain: Terrain,
    biomes: Biomes,
    includeSmallProps: boolean,
    field: HeightField,
  ): { group: THREE.Group; colliders: CylinderCollider[] } {
    const rng = new SeededRandom(combineSeed(this.seed, cx, cz, 8003));
    const size = WORLD.chunkSize;
    const originX = cx * size;
    const originZ = cz * size;
    const group = new THREE.Group();
    const colliders: CylinderCollider[] = [];
    const normal = new THREE.Vector3();
    const composeMatrix = new THREE.Matrix4();
    const composePosition = new THREE.Vector3();
    const composeQuaternion = new THREE.Quaternion();
    const composeEuler = new THREE.Euler();
    const composeScale = new THREE.Vector3();
    const scale = this.quality.propDensityScale;

    const place = (
      geo: THREE.BufferGeometry,
      material: THREE.Material,
      items: Array<{ m: THREE.Matrix4; c?: THREE.Color }>,
      shadows: boolean,
    ) => {
      if (items.length === 0) return;
      const mesh = new THREE.InstancedMesh(geo, material, items.length);
      for (let i = 0; i < items.length; i++) {
        mesh.setMatrixAt(i, items[i].m);
        if (items[i].c) mesh.setColorAt(i, items[i].c!);
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.castShadow = shadows;
      mesh.receiveShadow = true;
      group.add(mesh);
    };

    const compose = (x: number, y: number, z: number, rotY: number, s: number, sy = s) => {
      composePosition.set(x, y, z);
      composeEuler.set(0, rotY, 0);
      composeQuaternion.setFromEuler(composeEuler);
      composeScale.set(s, sy, s);
      composeMatrix.compose(composePosition, composeQuaternion, composeScale);
      return composeMatrix.clone();
    };

    // --- Boulders: prefer steep / rocky / shoreline spots ---
    const boulderItems: Array<{ m: THREE.Matrix4 }>[] = this.boulderGeos.map(() => []);
    const boulderAttempts = Math.floor(PROPS.boulderAttempts * scale);
    for (let i = 0; i < boulderAttempts; i++) {
      const x = originX + rng.next() * size;
      const z = originZ + rng.next() * size;
      const h = field.meshHeight(x, z);
      field.normal(x, z, normal);
      const steep = 1 - normal.y;
      const nearWater = Math.abs(h - WORLD.waterLevel) < 4 ? PROPS.boulderNearWaterBonus : 0;
      const p = steep * PROPS.boulderSlopeWeight + nearWater + 0.05;
      if (rng.next() >= p) continue;
      const s = rng.range(PROPS.boulderScaleMin, PROPS.boulderScaleMax);
      const variant = rng.int(0, this.boulderGeos.length - 1);
      // Partially sink into the terrain.
      boulderItems[variant].push({ m: compose(x, h - s * 0.3, z, rng.range(0, Math.PI * 2), s) });
      if (s > 1.1) colliders.push({ x, z, radius: s * PROPS.boulderColliderFactor });
    }
    boulderItems.forEach((items, v) => place(this.boulderGeos[v], withLodAlpha(this.materials.rock), items, true));

    if (!includeSmallProps) return { group, colliders };

    // --- Small stones ---
    const stoneItems: Array<{ m: THREE.Matrix4 }> = [];
    const stoneAttempts = Math.floor(PROPS.stoneAttempts * scale);
    for (let i = 0; i < stoneAttempts; i++) {
      const x = originX + rng.next() * size;
      const z = originZ + rng.next() * size;
      const h = field.meshHeight(x, z);
      if (h < WORLD.waterLevel + 0.2) continue;
      const s = rng.range(0.07, 0.3);
      stoneItems.push({ m: compose(x, h - s * 0.25, z, rng.range(0, Math.PI * 2), s) });
    }
    place(this.stoneGeo, withLodAlpha(this.materials.stone), stoneItems, false);

    // --- Fallen logs ---
    const logItems: Array<{ m: THREE.Matrix4 }> = [];
    if (rng.chance(0.6 * scale)) {
      const x = originX + rng.next() * size;
      const z = originZ + rng.next() * size;
      const h = field.meshHeight(x, z);
      field.normal(x, z, normal);
      if (h > WORLD.waterLevel + 0.5 && normal.y > 0.75) {
        const s = rng.range(0.8, 1.5);
        logItems.push({ m: compose(x, h, z, rng.range(0, Math.PI * 2), s, s) });
        colliders.push({ x, z, radius: 0.35 * s });
      }
    }
    place(this.logGeo, withLodAlpha(this.materials.log), logItems, true);

    return { group, colliders };
  }

}
