import * as THREE from 'three';
import { FOLIAGE, GRASS, WORLD, type QualitySettings } from '../config';
import { Noise2D } from '../procedural/Noise';
import type { MaterialLibrary } from '../procedural/Materials';
import { GRASS_FRAGMENT, GRASS_VERTEX } from '../shaders/grass';
import { createWindTrunkMaterial } from '../shaders/treeWind';
import { combineSeed, SeededRandom } from '../utils/Random';
import { bakeFoliageAtlas } from '../vegetation/CardAtlas';
import { bladeTuft, reedTuft, cactusCluster } from '../vegetation/Sward';
import { SeedStream } from '../vegetation/SeedStream';
import { TREE_CATALOG } from '../vegetation/TreeCatalog';
import { assembleTree } from '../vegetation/Assemble';
import {
  FERN_PROTO,
  SHRUB_CATALOG,
  assembleFern,
  assembleFlower,
  assembleShrub,
  type BloomKind,
} from '../vegetation/Undergrowth';
import type { TreeProfile } from '../vegetation/Botany';
import type { CylinderCollider } from '../core/CameraController';
import type { SharedEnvUniforms } from './Environment';
import type { Biomes } from './Biomes';
import type { Terrain, HeightField } from './Terrain';
import type { GrassSettings } from './GrassSettings';
import { clearingForChunk, CLEARING_BARE_RADIUS } from './Clearings';
import { WorldPalette } from '../settings/Palette';

const { GRASS_COOL, GRASS_WARM, REED_TAN, REED_BROWN, CACTUS_GREEN, CACTUS_GRAY } = WorldPalette;

export interface TreePlacement {
  x: number;
  y: number;
  z: number;
  species: string;
  scale: number;
  rotY: number;
  lean: number;
  leanDir: number;
  tint: number;
  variant: number;
  autumnFactor: number;
}

export const GRASS_TILES_PER_CHUNK = GRASS.tilesPerChunk;
const GRASS_TILE_SIZE = WORLD.chunkSize / Math.sqrt(GRASS_TILES_PER_CHUNK);

interface TreeTemplate {
  bark: THREE.BufferGeometry;
  foliage: THREE.BufferGeometry | null;
  barkMaterial: THREE.Material;
  foliageMaterial: THREE.Material | null;
  collisionRadius: number;
}

interface UndergrowthTemplate {
  bark: THREE.BufferGeometry | null;
  foliage: THREE.BufferGeometry;
  barkMaterial: THREE.Material | null;
  foliageMaterial: THREE.Material;
}

const TREE_VARIANTS = 3;
const UNDERGROWTH_VARIANTS = 2;
const UP = new THREE.Vector3(0, 1, 0);
const IDENTITY_QUAT = new THREE.Quaternion();
const FLOWER_KINDS: readonly BloomKind[] = ['umbel', 'bell', 'daisy'];

const FOLIAGE_VERTEX = /* glsl */ `
#include <common>
#include <fog_pars_vertex>

attribute vec4 vdata;
attribute float aHeightGradient;
attribute float aAutumn;
attribute float aChunkSlot;
uniform float uSlotAlpha[32];
uniform float uLodAlpha;
uniform float uTime;
uniform vec2 uWindDir;
uniform float uWindStrength;
varying vec2 vUv;
varying vec4 vData;
varying float vHeightGradient;
varying float vAutumn;
varying vec3 vInstanceColor;
varying float vLodAlpha;

void main() {
  vUv = uv;
  vData = vdata;
  vHeightGradient = aHeightGradient;
  vAutumn = aAutumn;
  vLodAlpha = uSlotAlpha[int(aChunkSlot)] * uLodAlpha;
  #ifdef USE_INSTANCING_COLOR
    vInstanceColor = instanceColor;
  #else
    vInstanceColor = vec3(1.0);
  #endif
  vec3 transformed = position;
  #ifdef USE_INSTANCING
    vec4 worldOrigin = modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  #else
    vec4 worldOrigin = modelMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  #endif
  float phase = vdata.z + worldOrigin.x * 0.17 + worldOrigin.z * 0.13;
  float wave = sin(uTime * 1.15 + phase) * 0.65 + sin(uTime * 0.47 + phase * 1.7) * 0.35;
  float sway = wave * uWindStrength * vdata.y * 0.16;
  transformed.x += uWindDir.x * sway;
  transformed.z += uWindDir.y * sway;
  #ifdef USE_INSTANCING
    vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(transformed, 1.0);
  #else
    vec4 mvPosition = modelViewMatrix * vec4(transformed, 1.0);
  #endif
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const FOLIAGE_FRAGMENT = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
uniform sampler2D uMap;
uniform vec3 uSunColor;
uniform vec3 uAmbientColor;
uniform vec3 uGroundBounceColor;
uniform float uNight;
uniform float uBottomBrightness;
uniform float uGradientCurve;
uniform float uColorContrast;
uniform float uColorVariation;
varying float vLodAlpha;
uniform vec3 uBloomColor;
uniform float uBloomFrac;
uniform vec3 uAutumnColor;
varying vec2 vUv;
varying vec4 vData;
varying float vHeightGradient;
varying float vAutumn;
varying vec3 vInstanceColor;

const float BAYER[16] = float[16](
  0.0/16.0,  8.0/16.0,  2.0/16.0, 10.0/16.0,
  12.0/16.0, 4.0/16.0, 14.0/16.0,  6.0/16.0,
  3.0/16.0, 11.0/16.0,  1.0/16.0,  9.0/16.0,
  15.0/16.0,  7.0/16.0, 13.0/16.0,  5.0/16.0
);

void main() {
  vec4 tex = texture2D(uMap, vUv);
  if (tex.a < 0.42) discard;
  float _bayer = BAYER[int(mod(gl_FragCoord.x, 4.0)) * 4 + int(mod(gl_FragCoord.y, 4.0))];
  if (vLodAlpha < _bayer + 0.001) discard;
  vec3 albedo = tex.rgb * tex.rgb;
  float hue = vData.x * 0.12;
  albedo *= vec3(1.0 + hue, 1.0, 1.0 - hue * 0.7);
  float colorSeed = fract(vData.z * 0.618 + vData.x * 1.713);
  vec3 cool = vec3(0.72, 0.94, 1.12);
  vec3 warm = vec3(1.18, 1.03, 0.62);
  albedo *= mix(vec3(1.0), mix(cool, warm, colorSeed), uColorVariation);
  albedo = mix(vec3(dot(albedo, vec3(0.299, 0.587, 0.114))), albedo, uColorContrast);
  vec3 light = uAmbientColor * 1.05 + uGroundBounceColor * 0.18 + uSunColor * 0.34;
  light *= 1.0 - uNight * 0.38;
  float heightLight = mix(uBottomBrightness, 1.0, pow(vHeightGradient, uGradientCurve));
  gl_FragColor = vec4(albedo * vInstanceColor * light * vData.w * heightLight, 1.0);
  // Cherry bloom: tint toward bloom colour in daylight
  vec3 bloomShift = mix(gl_FragColor.rgb, gl_FragColor.rgb * uBloomColor * 2.2, uBloomFrac * (1.0 - uNight));
  gl_FragColor.rgb = mix(gl_FragColor.rgb, bloomShift, uBloomFrac);
  // Autumn tint: per-instance hue shift
  gl_FragColor.rgb = mix(gl_FragColor.rgb, gl_FragColor.rgb * uAutumnColor * 2.1, vAutumn * 0.75);
  #include <fog_fragment>
}
`;

const FLOWER_VERTEX = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
attribute vec4 vdata;
uniform float uTime;
uniform vec2 uWindDir;
uniform float uWindStrength;
varying vec4 vData;
void main() {
  vData = vdata;
  vec3 transformed = position;
  float sway = sin(uTime * 1.7 + position.y * 3.0) * uWindStrength * position.y * 0.08;
  transformed.x += uWindDir.x * sway;
  transformed.z += uWindDir.y * sway;
  vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(transformed, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const FLOWER_FRAGMENT = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
uniform vec3 uSunColor;
uniform vec3 uAmbientColor;
uniform float uLodAlpha;
varying vec4 vData;
const float _FBAYER[16]=float[16](0.0/16.0,8.0/16.0,2.0/16.0,10.0/16.0,12.0/16.0,4.0/16.0,14.0/16.0,6.0/16.0,3.0/16.0,11.0/16.0,1.0/16.0,9.0/16.0,15.0/16.0,7.0/16.0,13.0/16.0,5.0/16.0);
void main() {
  if(uLodAlpha<_FBAYER[int(mod(gl_FragCoord.x,4.0))*4+int(mod(gl_FragCoord.y,4.0))]+0.001)discard;
  vec3 green = vec3(0.12, 0.28, 0.055);
  vec3 center = vec3(0.95, 0.65, 0.12);
  vec3 petal = vec3(0.82, 0.52, 0.76);
  vec3 color = mix(green, petal, step(0.75, vData.x));
  color = mix(color, center, step(0.25, vData.x) * (1.0 - step(0.75, vData.x)));
  gl_FragColor = vec4(color * (uAmbientColor * 1.8 + uSunColor * 0.9), 1.0);
  #include <fog_fragment>
}
`;

function foliageMaterial(
  texture: THREE.Texture,
  env: SharedEnvUniforms,
  bloomColor?: { r: number; g: number; b: number },
  bloomFrac?: number,
  autumnColor?: { r: number; g: number; b: number },
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: FOLIAGE_VERTEX,
    fragmentShader: FOLIAGE_FRAGMENT,
    uniforms: {
      ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
      uMap: { value: texture },
      uTime: env.uTime,
      uWindDir: env.uWindDir,
      uWindStrength: env.uWindStrength,
      uSunColor: env.uSunColor,
      uAmbientColor: env.uAmbientColor,
      uGroundBounceColor: env.uGroundBounceColor,
      uNight: env.uNight,
      uSlotAlpha: { value: new Float32Array(32).fill(1.0) },
      uLodAlpha: { value: 1.0 },
      uBottomBrightness: { value: FOLIAGE.bottomBrightness },
      uGradientCurve: { value: FOLIAGE.gradientCurve },
      uColorContrast: { value: FOLIAGE.colorContrast },
      uColorVariation: { value: FOLIAGE.colorVariation },
      uBloomColor: { value: bloomColor ? new THREE.Color(bloomColor.r, bloomColor.g, bloomColor.b) : new THREE.Color(1, 1, 1) },
      uBloomFrac:  { value: bloomFrac ?? 0 },
      uAutumnColor: { value: autumnColor ? new THREE.Color(autumnColor.r, autumnColor.g, autumnColor.b) : new THREE.Color(1, 1, 1) },
    },
    side: THREE.DoubleSide,
    fog: true,
  });
}

function flowerMaterial(env: SharedEnvUniforms): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: FLOWER_VERTEX,
    fragmentShader: FLOWER_FRAGMENT,
    uniforms: {
      ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
      uTime: env.uTime,
      uWindDir: env.uWindDir,
      uWindStrength: env.uWindStrength,
      uSunColor: env.uSunColor,
      uAmbientColor: env.uAmbientColor,
      uLodAlpha: { value: 1.0 },
    },
    side: THREE.DoubleSide,
    fog: true,
  });
}

/**
 * Vegetation facade. The procedural flora kit (src/vegetation) owns every tree,
 * shrub, fern, and flower model; this class adapts those models to Beyond
 * Fable's chunk streaming, terrain sampling, wind, and biomes.
 */
export class Vegetation {
  private readonly templates = new Map<string, TreeTemplate[]>();
  private readonly farTemplates = new Map<string, TreeTemplate[]>();
  private readonly undergrowth = new Map<string, UndergrowthTemplate[]>();
  private readonly grassGeometries: readonly THREE.BufferGeometry[];
  private readonly reedGeometries: readonly THREE.BufferGeometry[];
  private readonly cactusGeometries: readonly THREE.BufferGeometry[];
  private readonly grassMaterial: THREE.ShaderMaterial;
  private readonly grassTiles = new Set<THREE.InstancedMesh>();
  // Tiles whose count is still ramping up from 0 toward grassFullCount.
  private readonly warmingGrassTiles = new Set<THREE.InstancedMesh>();
  private grassLodX = Number.POSITIVE_INFINITY;
  private grassLodZ = Number.POSITIVE_INFINITY;
  private grassLodDirty = true;
  private readonly flowerTemplates: THREE.BufferGeometry[];
  private readonly flowerMaterial: THREE.ShaderMaterial;
  private readonly groveNoise: Noise2D;
  private readonly groundPatchNoise: Noise2D;
  private exclusion: { x: number; z: number; radius: number } | null = null;
  // Cached template compiled once; each buildFarUndergrowth call clones it
  // so the GL program is reused rather than recompiled per chunk.
  private readonly farUndergrowthMatTemplate: THREE.ShaderMaterial = new THREE.ShaderMaterial({
    uniforms: { uLodAlpha: { value: 1.0 } },
    vertexShader: `void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `
      uniform float uLodAlpha;
      const float BAYER[16] = float[16](
        0.0/16.0, 8.0/16.0, 2.0/16.0,10.0/16.0,
        12.0/16.0,4.0/16.0,14.0/16.0, 6.0/16.0,
        3.0/16.0,11.0/16.0, 1.0/16.0, 9.0/16.0,
        15.0/16.0,7.0/16.0,13.0/16.0, 5.0/16.0
      );
      void main() {
        float _b = BAYER[int(mod(gl_FragCoord.x,4.0))*4+int(mod(gl_FragCoord.y,4.0))];
        if (uLodAlpha < _b + 0.001) discard;
        gl_FragColor = vec4(0.15, 0.32, 0.08, 1.0);
      }
    `,
    side: THREE.DoubleSide,
  });
  private readonly farUndergrowthGeo: THREE.PlaneGeometry = new THREE.PlaneGeometry(1.8, 1.8);

  private addFoliageHeightGradient(geometry: THREE.BufferGeometry): void {
    geometry.computeBoundingBox();
    const box = geometry.boundingBox!;
    const span = Math.max(box.max.y - box.min.y, 0.001);
    const position = geometry.getAttribute('position') as THREE.BufferAttribute;
    const gradient = new Float32Array(position.count);
    for (let i = 0; i < position.count; i++) {
      gradient[i] = THREE.MathUtils.clamp((position.getY(i) - box.min.y) / span, 0, 1);
    }
    geometry.setAttribute('aHeightGradient', new THREE.BufferAttribute(gradient, 1));
  }

  constructor(
    private readonly seed: number,
    renderer: THREE.WebGLRenderer,
    materials: MaterialLibrary,
    private readonly quality: QualitySettings,
    env: SharedEnvUniforms,
    private readonly grassSettings: GrassSettings,
  ) {
    this.groveNoise = new Noise2D(combineSeed(seed, 311));
    this.groundPatchNoise = new Noise2D(combineSeed(seed, 312));

    for (let si = 0; si < TREE_CATALOG.length; si++) {
      const species = TREE_CATALOG[si] as TreeProfile;
      const atlas = species.canopy
        ? bakeFoliageAtlas(renderer, species, new SeedStream(combineSeed(seed, 300, si)))
        : null;
      const leafMat = atlas ? foliageMaterial(
        atlas, env,
        species.bloom ? { r: species.bloom.r, g: species.bloom.g, b: species.bloom.b } : undefined,
        species.bloom?.frac,
        species.autumnTint,
      ) : null;
      const barkBase = species.kind === 'snag'
        ? materials.deadWood
        : species.id === 'birch' ? materials.barkBirch : materials.bark;
      const barkMat = createWindTrunkMaterial(barkBase, env);
      const detail: TreeTemplate[] = [];
      const far: TreeTemplate[] = [];
      for (let v = 0; v < TREE_VARIANTS; v++) {
        detail.push(this.makeTreeTemplate(species, v, 1, barkMat, leafMat));
        far.push(this.makeTreeTemplate(species, v, 2, barkBase, leafMat));
      }
      this.templates.set(species.id, detail);
      this.farTemplates.set(species.id, far);
    }

    for (let si = 0; si < SHRUB_CATALOG.length; si++) {
      const species = SHRUB_CATALOG[si] as TreeProfile;
      const atlas = bakeFoliageAtlas(renderer, species, new SeedStream(combineSeed(seed, 400, si)));
      const leafMat = foliageMaterial(atlas, env);
      const variants: UndergrowthTemplate[] = [];
      for (let v = 0; v < UNDERGROWTH_VARIANTS; v++) {
        const built = assembleShrub(species, new SeedStream(combineSeed(seed, 410, si, v)));
        this.addFoliageHeightGradient(built.foliage!);
        variants.push({
          bark: built.bark,
          foliage: built.foliage!,
          barkMaterial: materials.bark,
          foliageMaterial: leafMat,
        });
      }
      this.undergrowth.set(species.id, variants);
    }

    const fernAtlas = bakeFoliageAtlas(renderer, FERN_PROTO, new SeedStream(combineSeed(seed, 420)));
    const fernMat = foliageMaterial(fernAtlas, env);
    this.undergrowth.set('fern', Array.from({ length: UNDERGROWTH_VARIANTS }, (_, v) => {
      const foliage = assembleFern(new SeedStream(combineSeed(seed, 421, v)));
      this.addFoliageHeightGradient(foliage);
      return {
        bark: null,
        foliage,
        barkMaterial: null,
        foliageMaterial: fernMat,
      };
    }));

    this.flowerTemplates = FLOWER_KINDS.map((kind, i) =>
      assembleFlower(kind, new SeedStream(combineSeed(seed, 430, i))));
    this.flowerMaterial = flowerMaterial(env);
    this.grassGeometries = [
      bladeTuft(7, 3),
      bladeTuft(3, 2),
      bladeTuft(3, 1),
    ];
    for (const geometry of this.grassGeometries) geometry.deleteAttribute('normal');
    this.reedGeometries = [reedTuft(4, 6), reedTuft(3, 4), reedTuft(2, 2)];
    for (const geometry of this.reedGeometries) geometry.deleteAttribute('normal');
    this.cactusGeometries = [cactusCluster(0), cactusCluster(1), cactusCluster(2)];
    for (const geometry of this.cactusGeometries) geometry.deleteAttribute('normal');
    this.grassMaterial = new THREE.ShaderMaterial({
      vertexShader: GRASS_VERTEX,
      fragmentShader: GRASS_FRAGMENT,
      uniforms: {
        ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
        uTime: env.uTime,
        uWindDir: env.uWindDir,
        uWindStrength: env.uWindStrength,
        uSunDir: env.uSunDir,
        uSunColor: env.uSunColor,
        uAmbientColor: env.uAmbientColor,
        uGroundBounceColor: env.uGroundBounceColor,
        uNight: env.uNight,
        uLodAlpha: { value: 1.0 },
        uRenderDist: { value: this.grassSettings.renderDistance },
      },
      side: THREE.DoubleSide,
      transparent: true,
      fog: true,
    });
  }

  setExclusion(x: number, z: number, radius: number): void {
    this.exclusion = { x, z, radius };
  }

  getGrassSettings(): Readonly<GrassSettings> {
    return this.grassSettings;
  }

  private makeTreeTemplate(
    species: TreeProfile,
    variant: number,
    lod: 1 | 2,
    barkMaterial: THREE.Material,
    foliageMaterial: THREE.Material | null,
  ): TreeTemplate {
    const tree = assembleTree(species, new SeedStream(combineSeed(this.seed, 301, variant, species.id.length)), {
      lod,
      bias: {
        maturity: 0.55 + variant * 0.2,
        leanX: variant === 1 ? 0.035 : -0.015 * variant,
        leanZ: variant === 2 ? 0.045 : 0,
      },
    });
    if (tree.foliage) this.addFoliageHeightGradient(tree.foliage);
    return {
      bark: tree.bark,
      foliage: tree.foliage,
      barkMaterial,
      foliageMaterial,
      collisionRadius: tree.metrics.height * species.girth * FOLIAGE.collisionRadiusFactor,
    };
  }

  /**
   * Swap shared grass geometry by camera distance. Small independently culled
   * tiles keep off-screen meadow triangles out of the draw entirely.
   *
   * Tiles also thin smoothly with distance by lowering instanceCount alone:
   * instances are stored in a shuffled order, so any count prefix is a
   * uniform random subset of the tile. Density transitions are therefore a
   * per-tile integer write - no rebuilds, no popping bands.
   */
  private _initLod(tileCX: number, tileCZ: number): 0 | 1 | 2 {
    const dx = tileCX - this.grassLodX;
    const dz = tileCZ - this.grassLodZ;
    const distSq = dx * dx + dz * dz;
    const near = this.grassSettings.nearLodDistance;
    const mid = this.grassSettings.midLodDistance;
    return distSq < near * near ? 0 : distSq < mid * mid ? 1 : 2;
  }

  updateGrassLod(playerPos: THREE.Vector3): void {
    const movedX = playerPos.x - this.grassLodX;
    const movedZ = playerPos.z - this.grassLodZ;
    const playerMoved = movedX * movedX + movedZ * movedZ >= GRASS.lodHysteresisDistSq;
    // Fast path: player hasn't moved and LOD isn't dirty — only tick warming tiles.
    if (!this.grassLodDirty && !playerMoved) {
      if (this.warmingGrassTiles.size > 0) this.tickWarmingTiles(playerPos);
      return;
    }
    this.grassLodX = playerPos.x;
    this.grassLodZ = playerPos.z;
    this.grassLodDirty = false;
    const near = this.grassSettings.nearLodDistance;
    const mid = this.grassSettings.midLodDistance;
    // Hysteresis band: require the tile to cross 8% past the threshold before
    // swapping geometry, preventing rapid back-and-forth at the boundary.
    const nearSq = near * near;
    const nearHystSq = (near * 1.08) * (near * 1.08);
    const midSq = mid * mid;
    const midHystSq = (mid * 1.08) * (mid * 1.08);
    const renderSq = this.grassSettings.renderDistance ** 2;
    const minFraction = THREE.MathUtils.clamp(this.grassSettings.edgeDensityMultiplier, GRASS.minEdgeDensityFraction, 1);
    for (const mesh of this.grassTiles) {
      const dx = mesh.userData.grassCenterX as number - playerPos.x;
      const dz = mesh.userData.grassCenterZ as number - playerPos.z;
      const distSq = dx * dx + dz * dz;
      mesh.visible = distSq < renderSq;
      if (!mesh.visible) continue;
      // Geometry LOD with hysteresis: only upgrade (lower lod index) at strict
      // threshold; only downgrade at the outer hysteresis boundary.
      const curLod = (mesh.userData.grassLod as number) ?? 0;
      let lod = curLod;
      if (curLod > 0 && distSq < nearSq) lod = 0;
      else if (curLod < 2 && distSq > nearHystSq && distSq >= midSq) lod = 2;
      else if (curLod === 2 && distSq < midSq) lod = 1;
      else if (curLod === 0 && distSq > nearHystSq) lod = 1;
      else if (curLod === 1 && distSq > midHystSq) lod = 2;
      if (lod !== curLod) {
        const lodGeos = (mesh.userData.lodGeometries as THREE.BufferGeometry[] | undefined) ?? this.grassGeometries;
        mesh.geometry = lodGeos[lod];
        mesh.userData.grassLod = lod;
      }
      // ponytail: squared-distance smoothstep avoids sqrt per tile; curve shape is approximate but indistinguishable for this fade.
      const fade = THREE.MathUtils.smoothstep(distSq, near * near, mid * mid);
      const fraction = 1 - (1 - minFraction) * fade;
      const full = mesh.userData.grassFullCount as number;
      const target = Math.max(1, Math.round(full * fraction));
      if (this.warmingGrassTiles.has(mesh)) {
        const step = Math.max(1, Math.round(full * 0.08));
        const next = Math.min(target, (mesh.count || 0) + step);
        mesh.count = next;
        if (next >= target) this.warmingGrassTiles.delete(mesh);
      } else {
        mesh.count = target;
      }
    }
  }

  /** Advance only the warming tiles without scanning the full tile set. */
  private tickWarmingTiles(playerPos: THREE.Vector3): void {
    const near = this.grassSettings.nearLodDistance;
    const mid  = this.grassSettings.midLodDistance;
    const minFraction = THREE.MathUtils.clamp(this.grassSettings.edgeDensityMultiplier, GRASS.minEdgeDensityFraction, 1);
    for (const mesh of this.warmingGrassTiles) {
      const dx = (mesh.userData.grassCenterX as number) - playerPos.x;
      const dz = (mesh.userData.grassCenterZ as number) - playerPos.z;
      const distSq = dx * dx + dz * dz;
      const fade = THREE.MathUtils.smoothstep(distSq, near * near, mid * mid);
      const full = mesh.userData.grassFullCount as number;
      const target = Math.max(1, Math.round(full * (1 - (1 - minFraction) * fade)));
      const step = Math.max(1, Math.round(full * 0.08));
      const next = Math.min(target, (mesh.count || 0) + step);
      mesh.count = next;
      if (next >= target) this.warmingGrassTiles.delete(mesh);
    }
  }

  markGrassLodDirty(): void {
    this.grassLodDirty = true;
  }

  unregisterGrass(root: THREE.Object3D): void {
    root.traverse((obj) => {
      if (obj.userData.isGrassTile) {
        const mesh = obj as THREE.InstancedMesh;
        this.grassTiles.delete(mesh);
        this.warmingGrassTiles.delete(mesh);
      }
    });
    this.grassLodDirty = true;
  }

  private excluded(x: number, z: number): boolean {
    if (!this.exclusion) return false;
    const dx = x - this.exclusion.x;
    const dz = z - this.exclusion.z;
    return dx * dx + dz * dz < this.exclusion.radius * this.exclusion.radius;
  }

  private pickTreeSpecies(x: number, z: number, h: number, moisture: number, r: number): string {
    // High and dry ground stays coniferous.
    if (h > WORLD.treeLine * FOLIAGE.coniferHeightFrac || moisture < FOLIAGE.coniferMoistureMax)
      return r < FOLIAGE.spruceVsPineRatio ? 'spruce' : 'pine';
    // A rare flowering cherry, sprinkled thinly across the lowland woods so a
    // few stand out as something special wherever you wander.
    if (r < FOLIAGE.cherryChance) return 'cherry';
    if (r < FOLIAGE.snagChance) return 'snag';
    if (r < FOLIAGE.karstChance && h > FOLIAGE.karstMinHeight) return 'karst';
    // Damp lowlands favour heavy broadleaves; the elder oak towers over them.
    if (moisture > FOLIAGE.dampMoistureThreshold)
      return r < FOLIAGE.dampBeechRatio ? 'beech' : r < FOLIAGE.dampOakRatio ? 'oak' : r < FOLIAGE.dampBirchRatio ? 'birch' : 'spruce';
    return r < FOLIAGE.normalBeechRatio ? 'beech' : r < FOLIAGE.normalOakRatio ? 'oak' : r < FOLIAGE.normalBirchRatio ? 'birch' : r < FOLIAGE.normalPineRatio ? 'pine' : 'spruce';
  }

  /** Clustered groves with broad clearings between them. */
  generateTreePlacements(cx: number, cz: number, terrain: Terrain, biomes: Biomes, field: HeightField): TreePlacement[] {
    const rng = new SeededRandom(combineSeed(this.seed, cx, cz, 7001));
    const size = WORLD.chunkSize;
    const ox = cx * size;
    const oz = cz * size;
    const placements: TreePlacement[] = [];
    const normal = new THREE.Vector3();
    // A campfire clearing in this chunk keeps trees out of the open spot.
    const clearing = clearingForChunk(this.seed, cx, cz, terrain, biomes);
    const clearingSq = clearing ? clearing.radius * clearing.radius : 0;
    const attempts = Math.floor(FOLIAGE.treePlacementAttempts * this.quality.treeDensityScale);
    for (let i = 0; i < attempts && placements.length < FOLIAGE.maxTreesPerChunk; i++) {
      const x = ox + rng.next() * size;
      const z = oz + rng.next() * size;
      if (this.excluded(x, z)) continue;
      if (clearing && (x - clearing.x) ** 2 + (z - clearing.z) ** 2 < clearingSq) continue;
      const h = field.height(x, z);
      field.normal(x, z, normal);
      const density = biomes.getTreeDensity(x, z, h, normal.y);
      if (density <= 0) continue;
      const grove = this.groveNoise.fbm(x * FOLIAGE.groveNoiseFreq, z * FOLIAGE.groveNoiseFreq, 3) * 0.5 + 0.5;
      const edge = this.groveNoise.fbm(x * FOLIAGE.groveEdgeNoiseFreq + 31, z * FOLIAGE.groveEdgeNoiseFreq - 19, 2) * 0.5 + 0.5;
      const accept = Math.min(0.8, density * 22 * (0.15 + grove * grove * 1.9) * (0.55 + edge));
      if (!rng.chance(accept)) continue;
      const moisture = biomes.getMoisture(x, z);
      const species = this.pickTreeSpecies(x, z, h, moisture, rng.next());
      const heightFactor = Math.max(0, (h - FOLIAGE.autumnHeightMin) / FOLIAGE.autumnHeightRange);
      const autumnFactor = Math.min(1, (1 - moisture) * FOLIAGE.autumnMoistureWeight + heightFactor * FOLIAGE.autumnHeightWeight);
      placements.push({
        x,
        y: field.meshHeight(x, z) + FOLIAGE.treeSinkOffset,
        z,
        species,
        scale: (() => {
          const rawScale = rng.next();
          const sf = FOLIAGE.saplingFraction;
          return rawScale < sf        ? FOLIAGE.saplingScaleBase + rawScale * FOLIAGE.saplingScaleSlope
               : rawScale < 1 - sf    ? FOLIAGE.normalScaleBase + (rawScale - sf) * FOLIAGE.normalScaleSlope
               :                        FOLIAGE.giantScaleBase + (rawScale - (1 - sf)) * FOLIAGE.giantScaleSlope;
        })(),
        rotY: rng.range(0, Math.PI * 2),
        lean: rng.range(0, FOLIAGE.maxLean),
        leanDir: rng.range(0, Math.PI * 2),
        tint: rng.next(),
        variant: rng.int(0, TREE_VARIANTS - 1),
        autumnFactor,
      });
    }
    return placements;
  }

  buildTreeColliders(placements: TreePlacement[]): CylinderCollider[] {
    return placements.map((p) => ({
      x: p.x,
      z: p.z,
      radius: this.templates.get(p.species)![p.variant].collisionRadius * p.scale,
    }));
  }

  private buildTrees(
    chunkSlices: Array<{ key: string; placements: TreePlacement[] }>,
    far: boolean,
    shadows: boolean,
  ): { group: THREE.Group; instanceRanges: Map<string, Array<{ mesh: THREE.InstancedMesh; start: number; count: number; slot: number }>> } {
    const group = new THREE.Group();
    const instanceRanges = new Map<string, Array<{ mesh: THREE.InstancedMesh; start: number; count: number; slot: number }>>();
    const allPlacements = chunkSlices.flatMap(s => s.placements);
    const source = far ? this.farTemplates : this.templates;
    const matrix = new THREE.Matrix4();
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const euler = new THREE.Euler();
    const scale = new THREE.Vector3();
    const treeTint = new THREE.Color();
    for (const species of TREE_CATALOG) {
      for (let v = 0; v < TREE_VARIANTS; v++) {
        const subset = allPlacements.filter((p) => p.species === species.id && p.variant === v);
        if (subset.length === 0) continue;
        const template = source.get(species.id)![v];
        const batchBarkGeo = template.bark.clone();
        batchBarkGeo.userData.ownsGeometry = true;
        const bark = new THREE.InstancedMesh(batchBarkGeo, template.barkMaterial, subset.length);
        const batchFoliageGeo = template.foliage ? template.foliage.clone() : null;
        if (batchFoliageGeo) batchFoliageGeo.userData.ownsGeometry = true;
        // Clone foliage material per-mesh so each batch gets its own uSlotAlpha array.
        const leavesMat = batchFoliageGeo && template.foliageMaterial
          ? (template.foliageMaterial as THREE.ShaderMaterial).clone()
          : null;
        if (leavesMat) leavesMat.uniforms['uSlotAlpha'] = { value: new Float32Array(32).fill(1.0) };
        const leaves = batchFoliageGeo && leavesMat
          ? new THREE.InstancedMesh(batchFoliageGeo, leavesMat, subset.length)
          : null;
        for (let i = 0; i < subset.length; i++) {
          const p = subset[i];
          euler.set(Math.cos(p.leanDir) * p.lean, p.rotY, Math.sin(p.leanDir) * p.lean);
          quat.setFromEuler(euler);
          pos.set(p.x, p.y, p.z);
          scale.setScalar(p.scale);
          matrix.compose(pos, quat, scale);
          bark.setMatrixAt(i, matrix);
          if (leaves) {
            leaves.setMatrixAt(i, matrix);
            const tint = p.tint;
            treeTint.setRGB(
              0.72 + tint * 0.32,
              0.78 + (1 - Math.abs(tint - 0.5) * 2) * 0.22,
              0.58 + (1 - tint) * 0.42,
            );
            leaves.setColorAt(i, treeTint);
          }
        }
        // Bark keeps per-instance aLodAlpha (updated by writeLodAlpha for MeshStandardMaterial).
        const alphaArr = new Float32Array(subset.length).fill(1.0);
        bark.geometry.setAttribute('aLodAlpha', new THREE.InstancedBufferAttribute(alphaArr, 1));
        bark.instanceMatrix.needsUpdate = true;
        bark.castShadow = shadows;
        bark.receiveShadow = shadows;
        group.add(bark);
        if (leaves) {
          leaves.instanceMatrix.needsUpdate = true;
          if (leaves.instanceColor) leaves.instanceColor.needsUpdate = true;
          leaves.castShadow = shadows;
          // Per-instance autumn factor (zero for species without autumnTint)
          const autumnArr = new Float32Array(subset.length);
          if (species.autumnTint) {
            for (let i = 0; i < subset.length; i++) autumnArr[i] = subset[i].autumnFactor;
          }
          leaves.geometry.setAttribute('aAutumn', new THREE.InstancedBufferAttribute(autumnArr, 1));
          // aChunkSlot: static per-instance slot index for uSlotAlpha uniform lookup.
          const slotArr = new Float32Array(subset.length);
          let sOff = 0;
          for (let si = 0; si < chunkSlices.length; si++) {
            const cnt = chunkSlices[si].placements.filter(p => p.species === species.id && p.variant === v).length;
            slotArr.fill(si, sOff, sOff + cnt);
            sOff += cnt;
          }
          leaves.geometry.setAttribute('aChunkSlot', new THREE.InstancedBufferAttribute(slotArr, 1));
          group.add(leaves);
        }
        // Record per-chunk instance ranges for this (species, variant) mesh pair.
        let offset = 0;
        for (let si = 0; si < chunkSlices.length; si++) {
          const { key, placements: cp } = chunkSlices[si];
          const count = cp.filter(p => p.species === species.id && p.variant === v).length;
          if (count > 0) {
            if (!instanceRanges.has(key)) instanceRanges.set(key, []);
            const refs = instanceRanges.get(key)!;
            refs.push({ mesh: bark, start: offset, count, slot: si });
            if (leaves) refs.push({ mesh: leaves, start: offset, count, slot: si });
            offset += count;
          }
        }
      }
    }
    return { group, instanceRanges };
  }

  buildDetailedTrees(
    chunkSlices: Array<{ key: string; placements: TreePlacement[] }>,
    shadows = true,
  ): { group: THREE.Group; instanceRanges: Map<string, Array<{ mesh: THREE.InstancedMesh; start: number; count: number; slot: number }>> } {
    return this.buildTrees(chunkSlices, false, shadows);
  }

  buildFarTrees(
    chunkSlices: Array<{ key: string; placements: TreePlacement[] }>,
  ): { group: THREE.Group; instanceRanges: Map<string, Array<{ mesh: THREE.InstancedMesh; start: number; count: number; slot: number }>> } {
    return this.buildTrees(chunkSlices, true, false);
  }

  /** Deterministic Fisher-Yates over the first `count` instances. */
  private shuffleInstances(mesh: THREE.InstancedMesh, count: number, seed: number): void {
    const matrices = mesh.instanceMatrix.array as Float32Array;
    const colors = mesh.instanceColor ? (mesh.instanceColor.array as Float32Array) : null;
    let state = seed >>> 0;
    for (let i = count - 1; i > 0; i--) {
      state = (state * 1664525 + 1013904223) >>> 0;
      const j = state % (i + 1);
      if (j === i) continue;
      for (let k = 0; k < 16; k++) {
        const a = i * 16 + k;
        const b = j * 16 + k;
        const t = matrices[a];
        matrices[a] = matrices[b];
        matrices[b] = t;
      }
      if (colors) {
        for (let k = 0; k < 3; k++) {
          const a = i * 3 + k;
          const b = j * 3 + k;
          const t = colors[a];
          colors[a] = colors[b];
          colors[b] = t;
        }
      }
    }
  }

  /**
   * Dense sward: one jittered clump cell across every viable grassland
   * surface. Large patch fields vary height/color while biome rules
   * remove grass from water, snow, bare rock, and steep slopes.
   *
   * Implemented as a generator so the streamer can time-slice the expensive
   * terrain sampling across frames; yields land between cell rows, so the
   * RNG sequence (and therefore every placement) is identical to a
   * synchronous build. Aborting via `gen.return()` releases the partial mesh.
   */
  *buildGrassTile(
    cx: number,
    cz: number,
    tileIndex: number,
    terrain: Terrain,
    biomes: Biomes,
    field: HeightField,
    densityScale = 1,
  ): Generator<void, THREE.Group | null, void> {
    const tilesPerSide = Math.sqrt(GRASS_TILES_PER_CHUNK);
    const tx = tileIndex % tilesPerSide;
    const tz = Math.floor(tileIndex / tilesPerSide);
    const rng = new SeededRandom(combineSeed(this.seed, cx, cz, 7777, tileIndex));
    const size = GRASS_TILE_SIZE;
    const ox = cx * WORLD.chunkSize + tx * size;
    const oz = cz * WORLD.chunkSize + tz * size;
    const group = new THREE.Group();
    const normal = new THREE.Vector3();
    const matrix = new THREE.Matrix4();
    const pos = new THREE.Vector3();
    const tilt = new THREE.Quaternion();
    const yaw = new THREE.Quaternion();
    const quat = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const color = new THREE.Color();

    // Strip grass from the trampled centre of a campfire clearing, and keep
    // undergrowth out of the whole open spot.
    const clearing = clearingForChunk(this.seed, cx, cz, terrain, biomes);
    const clearingBareSq = clearing ? CLEARING_BARE_RADIUS * CLEARING_BARE_RADIUS : 0;
    const clearingFullSq = clearing ? clearing.radius * clearing.radius : 0;

    const groundItems = new Map<string, Array<{ matrix: THREE.Matrix4; variant: number }>>();
    const requestedDensity = Math.max(
      GRASS.minRequestedDensity,
      this.quality.grassDensity * densityScale * this.grassSettings.densityMultiplier,
    );
    const instanceDensity = Math.min(requestedDensity, this.grassSettings.instanceDensityCap);
    const densityWidth = Math.sqrt(requestedDensity / instanceDensity);
    const cell = 1 / Math.sqrt(instanceDensity);
    const cells = Math.ceil(size / cell);
    const mesh = new THREE.InstancedMesh(
      this.grassGeometries[0],
      this.grassMaterial,
      cells * cells,
    );
    let completed = false;
    try {
      let count = 0;
      for (let iz = 0; iz < cells; iz++) {
        yield;
        for (let ix = 0; ix < cells; ix++) {
          const x = ox + (ix + rng.range(0.08, 0.92)) * cell;
          const z = oz + (iz + rng.range(0.08, 0.92)) * cell;
          if (x >= ox + size || z >= oz + size) continue;
          if (clearing && (x - clearing.x) ** 2 + (z - clearing.z) ** 2 < clearingBareSq) continue;
          const h = field.height(x, z);
          field.normal(x, z, normal);
          const factor = biomes.getGrassFactor(x, z, h, normal.y);
          if (!rng.chance(Math.pow(factor, this.grassSettings.coverageExponent))) continue;
          const patchField = this.groundPatchNoise.fbm(x * 0.012, z * 0.012, 3) * 0.5 + 0.5;
          const finePatch = this.groundPatchNoise.fbm(x * 0.045 + 17, z * 0.045 - 29, 2) * 0.5 + 0.5;
          pos.set(x, field.meshHeight(x, z) + GRASS.bladeSinkOffset, z);
          tilt.setFromUnitVectors(UP, normal).slerp(IDENTITY_QUAT, GRASS.normalBlendFraction);
          yaw.setFromAxisAngle(UP, rng.range(0, Math.PI * 2));
          quat.copy(tilt).multiply(yaw);
          const s = rng.range(0.95, 1.38) * (0.88 + factor * 0.42) * densityWidth;
          const height =
            rng.range(0.58, 1.18) *
            (0.78 + patchField * 0.72) *
            this.grassSettings.heightMultiplier;
          scale.set(
            rng.range(0.95, 1.32) * s * this.grassSettings.widthMultiplier,
            height,
            rng.range(0.95, 1.32) * s * this.grassSettings.widthMultiplier,
          );
          matrix.compose(pos, quat, scale);
          const colorSeed = rng.next();
          color
            .setHex(
              colorSeed < GRASS.colorBucketT1 ? 0x183f20
                : colorSeed < GRASS.colorBucketT2 ? 0x56751c
                  : colorSeed < GRASS.colorBucketT3 ? 0x89712a
                    : colorSeed < GRASS.colorBucketT4 ? 0x2b6b26
                      : 0x739b36,
            )
            .lerp(
              colorSeed < 0.5 ? GRASS_COOL : GRASS_WARM,
              this.grassSettings.colorVariation * (GRASS.colorVariationFloor + Math.abs(colorSeed - 0.5)),
            )
            .multiplyScalar(
              (GRASS.brightnessBase + finePatch * GRASS.brightnessRange) *
              (1 + (patchField - 0.5) * this.grassSettings.colorContrast),
            );
          mesh.setMatrixAt(count, matrix);
          mesh.setColorAt(count, color);
          count++;
        }
      }
      if (count > 1) {
        // Shuffle instance storage order so distance thinning can use a
        // simple count prefix as a uniform random subset of the tile.
        yield;
        this.shuffleInstances(mesh, count, combineSeed(this.seed, cx, cz, 9311, tileIndex));
      }
      if (count > 0) {
        mesh.count = count;
        mesh.userData.grassFullCount = count;
        mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) {
          mesh.instanceColor.setUsage(THREE.StaticDrawUsage);
          mesh.instanceColor.needsUpdate = true;
        }
        mesh.computeBoundingSphere();
        mesh.userData.isGrassTile = true;
        mesh.userData.grassCenterX = ox + size * 0.5;
        mesh.userData.grassCenterZ = oz + size * 0.5;
        mesh.userData.grassLod = 0;
        // Start invisible and ramp up so the tile fades in rather than popping.
        mesh.count = 0;
        this.grassTiles.add(mesh);
        this.warmingGrassTiles.add(mesh);
        this.grassLodDirty = true;
        group.add(mesh);
      } else {
        mesh.dispose();
      }

      // Larger ground plants remain colony-based and much rarer than grass.
      const undergrowthAttempts = Math.floor(
        GRASS.undergrowthAttempts * densityScale * this.grassSettings.undergrowthMultiplier / GRASS_TILES_PER_CHUNK,
      );
      for (let i = 0; i < undergrowthAttempts; i++) {
        if ((i & 3) === 0) yield;
        const x = ox + rng.next() * size;
        const z = oz + rng.next() * size;
        if (clearing && (x - clearing.x) ** 2 + (z - clearing.z) ** 2 < clearingFullSq) continue;
        const h = field.height(x, z);
        field.normal(x, z, normal);
        const factor = biomes.getGrassFactor(x, z, h, normal.y);
        if (!rng.chance(factor * GRASS.undergrowthAcceptFactor)) continue;
        const patchField = this.groundPatchNoise.fbm(x * 0.012, z * 0.012, 3) * 0.5 + 0.5;
        pos.set(x, field.meshHeight(x, z) + GRASS.bladeSinkOffset, z);
        tilt.setFromUnitVectors(UP, normal).slerp(IDENTITY_QUAT, GRASS.normalBlendFraction);
        yaw.setFromAxisAngle(UP, rng.range(0, Math.PI * 2));
        quat.copy(tilt).multiply(yaw);
        if (rng.chance(FOLIAGE.undergrowthShrubChance)) {
            const forest = biomes.getForestMask(x, z);
            const kind = forest > FOLIAGE.undergrowthFernForestThreshold
              ? (rng.chance(FOLIAGE.undergrowthFernChance) ? 'fern' : 'bushHazel')
              : rng.chance(FOLIAGE.undergrowthPinkChance) ? 'bushPink' : 'bushJuniper';
            const variants = this.undergrowth.get(kind)!;
            const variant = rng.int(0, variants.length - 1);
            scale.setScalar(kind === 'fern' ? rng.range(FOLIAGE.fernScaleMin, FOLIAGE.fernScaleMax) : rng.range(FOLIAGE.shrubScaleMin, FOLIAGE.shrubScaleMax));
            matrix.compose(pos, quat, scale);
            const items = groundItems.get(kind) ?? [];
            items.push({ matrix: matrix.clone(), variant });
            groundItems.set(kind, items);
        } else if (patchField > FOLIAGE.flowerPatchThreshold) {
            const kind = `flower${rng.int(0, this.flowerTemplates.length - 1)}`;
            scale.setScalar(rng.range(FOLIAGE.flowerScaleMin, FOLIAGE.flowerScaleMax));
            matrix.compose(pos, quat, scale);
            const items = groundItems.get(kind) ?? [];
            items.push({ matrix: matrix.clone(), variant: 0 });
            groundItems.set(kind, items);
        }
      }

      for (const [kind, items] of groundItems) {
        if (kind.startsWith('flower')) {
          const geo = this.flowerTemplates[Number(kind.slice(6))];
          const mesh = new THREE.InstancedMesh(geo, this.flowerMaterial, items.length);
          items.forEach((item, i) => mesh.setMatrixAt(i, item.matrix));
          mesh.instanceMatrix.needsUpdate = true;
          group.add(mesh);
          continue;
        }
        const variants = this.undergrowth.get(kind)!;
        for (let v = 0; v < variants.length; v++) {
          const subset = items.filter((item) => item.variant === v);
          if (subset.length === 0) continue;
          const template = variants[v];
          if (template.bark && template.barkMaterial) {
            const bark = new THREE.InstancedMesh(template.bark, template.barkMaterial, subset.length);
            subset.forEach((item, i) => bark.setMatrixAt(i, item.matrix));
            bark.instanceMatrix.needsUpdate = true;
            group.add(bark);
          }
          const leaves = new THREE.InstancedMesh(template.foliage, template.foliageMaterial, subset.length);
          subset.forEach((item, i) => leaves.setMatrixAt(i, item.matrix));
          leaves.instanceMatrix.needsUpdate = true;
          group.add(leaves);
        }
      }

      // ── Reed population: near-water, moist shorelines ─────────────────────
      {
        const reedRng = new SeededRandom(combineSeed(this.seed, cx, cz, 8888, tileIndex));
        const reedMax = Math.floor(cells * cells * FOLIAGE.reedDensityFraction);
        const reedMatrices: THREE.Matrix4[] = [];
        const reedColorArr: THREE.Color[] = [];
        for (let i = 0; i < reedMax; i++) {
          const x = ox + reedRng.next() * size;
          const z = oz + reedRng.next() * size;
          const h = field.height(x, z);
          if (h < WORLD.waterLevel + FOLIAGE.reedWaterHeightMin || h > WORLD.waterLevel + FOLIAGE.reedWaterHeightMax) continue;
          field.normal(x, z, normal);
          if (normal.y < FOLIAGE.reedMinSlopeNormal) continue;
          if (!reedRng.chance(biomes.getMoisture(x, z) > FOLIAGE.reedMoistureThreshold ? FOLIAGE.reedAcceptance : 0)) continue;
          if (clearing && (x - clearing.x) ** 2 + (z - clearing.z) ** 2 < clearingBareSq) continue;
          pos.set(x, field.meshHeight(x, z) + GRASS.bladeSinkOffset, z);
          yaw.setFromAxisAngle(UP, reedRng.range(0, Math.PI * 2));
          const sw = reedRng.range(FOLIAGE.reedScaleHMin, FOLIAGE.reedScaleHMax);
          scale.set(sw, reedRng.range(FOLIAGE.reedScaleVMin, FOLIAGE.reedScaleVMax) * this.grassSettings.heightMultiplier, sw);
          matrix.compose(pos, yaw, scale);
          reedMatrices.push(matrix.clone());
          reedColorArr.push(reedRng.chance(0.5) ? REED_TAN : REED_BROWN);
        }
        if (reedMatrices.length > 0) {
          const tileCX = ox + size * 0.5;
          const tileCZ = oz + size * 0.5;
          const reedInitLod = this._initLod(tileCX, tileCZ);
          const reedMesh = new THREE.InstancedMesh(this.reedGeometries[reedInitLod], this.grassMaterial, reedMatrices.length);
          reedMatrices.forEach((m, i) => { reedMesh.setMatrixAt(i, m); reedMesh.setColorAt(i, reedColorArr[i]); });
          reedMesh.instanceMatrix.needsUpdate = true;
          if (reedMesh.instanceColor) reedMesh.instanceColor.needsUpdate = true;
          reedMesh.userData.isGrassTile = true;
          reedMesh.userData.grassCenterX = tileCX;
          reedMesh.userData.grassCenterZ = tileCZ;
          reedMesh.userData.grassLod = reedInitLod;
          reedMesh.userData.grassFullCount = reedMatrices.length;
          reedMesh.userData.lodGeometries = this.reedGeometries;
          this.grassTiles.add(reedMesh);
          this.grassLodDirty = true;
          group.add(reedMesh);
        }
      }

      // ── Cactus population: dry low-altitude areas ─────────────────────────
      {
        const cactusRng = new SeededRandom(combineSeed(this.seed, cx, cz, 9999, tileIndex));
        const cactusMax = Math.floor(cells * cells * FOLIAGE.cactusDensityFraction);
        const cactusMatrices: THREE.Matrix4[] = [];
        const cactusColorArr: THREE.Color[] = [];
        for (let i = 0; i < cactusMax; i++) {
          const x = ox + cactusRng.next() * size;
          const z = oz + cactusRng.next() * size;
          const h = field.height(x, z);
          if (h < WORLD.waterLevel + FOLIAGE.cactusWaterClearance || h > WORLD.snowHeight - FOLIAGE.cactusSnowBand) continue;
          if (biomes.getMoisture(x, z) >= FOLIAGE.cactusMoistureMax) continue;
          field.normal(x, z, normal);
          if (biomes.getGrassFactor(x, z, h, normal.y) < FOLIAGE.cactusMinGrassFactor) continue;
          if (!cactusRng.chance(FOLIAGE.cactusAcceptance)) continue;
          if (clearing && (x - clearing.x) ** 2 + (z - clearing.z) ** 2 < clearingBareSq) continue;
          pos.set(x, field.meshHeight(x, z) + GRASS.bladeSinkOffset, z);
          yaw.setFromAxisAngle(UP, cactusRng.range(0, Math.PI * 2));
          const sw = cactusRng.range(FOLIAGE.cactusScaleHMin, FOLIAGE.cactusScaleHMax);
          scale.set(sw, cactusRng.range(FOLIAGE.cactusScaleVMin, FOLIAGE.cactusScaleVMax) * this.grassSettings.heightMultiplier, sw);
          matrix.compose(pos, yaw, scale);
          cactusMatrices.push(matrix.clone());
          cactusColorArr.push(cactusRng.chance(FOLIAGE.cactusGreenChance) ? CACTUS_GREEN : CACTUS_GRAY);
        }
        if (cactusMatrices.length > 0) {
          const tileCX = ox + size * 0.5;
          const tileCZ = oz + size * 0.5;
          const cactusInitLod = this._initLod(tileCX, tileCZ);
          const cactusMesh = new THREE.InstancedMesh(this.cactusGeometries[cactusInitLod], this.grassMaterial, cactusMatrices.length);
          cactusMatrices.forEach((m, i) => { cactusMesh.setMatrixAt(i, m); cactusMesh.setColorAt(i, cactusColorArr[i]); });
          cactusMesh.instanceMatrix.needsUpdate = true;
          if (cactusMesh.instanceColor) cactusMesh.instanceColor.needsUpdate = true;
          cactusMesh.userData.isGrassTile = true;
          cactusMesh.userData.grassCenterX = tileCX;
          cactusMesh.userData.grassCenterZ = tileCZ;
          cactusMesh.userData.grassLod = cactusInitLod;
          cactusMesh.userData.grassFullCount = cactusMatrices.length;
          cactusMesh.userData.lodGeometries = this.cactusGeometries;
          this.grassTiles.add(cactusMesh);
          this.grassLodDirty = true;
          group.add(cactusMesh);
        }
      }

      completed = true;
      return group.children.length > 0 ? group : null;
    } finally {
      if (!completed) {
        // Aborted mid-build (chunk unloaded or LOD changed): release the
        // partial instance buffers and any LOD registration already made.
        this.grassTiles.delete(mesh);
        mesh.dispose();
      }
    }
  }

  buildFarUndergrowth(
    cx: number, cz: number,
    terrain: Terrain, biomes: Biomes,
    field: HeightField,
  ): THREE.InstancedMesh | null {
    const rng = new SeededRandom(combineSeed(this.seed, cx * 17 + cz * 31, 0xf7c2));
    const chunkOriginX = cx * WORLD.chunkSize;
    const chunkOriginZ = cz * WORLD.chunkSize;
    const attempts = FOLIAGE.farUndergrowthAttempts;
    const positions: Array<{ x: number; y: number; z: number; scale: number }> = [];

    for (let i = 0; i < attempts; i++) {
      const lx = rng.range(2, WORLD.chunkSize - 2);
      const lz = rng.range(2, WORLD.chunkSize - 2);
      const wx = chunkOriginX + lx, wz = chunkOriginZ + lz;
      const h = terrain.getMeshHeightAt(wx, wz);
      const moisture = biomes.getMoisture(wx, wz);
      const forestMask = biomes.getForestMask(wx, wz);
      if (forestMask < FOLIAGE.farUndergrowthForestMin || moisture < FOLIAGE.farUndergrowthMoistureMin) continue;
      positions.push({ x: wx, y: h, z: wz, scale: FOLIAGE.farUndergrowthScaleBase + rng.range(0, FOLIAGE.farUndergrowthScaleRange) });
    }

    if (positions.length === 0) return null;

    const mesh = new THREE.InstancedMesh(
      this.farUndergrowthGeo,
      this.farUndergrowthMatTemplate.clone(),
      positions.length,
    );
    mesh.castShadow = false;
    const dummy = new THREE.Object3D();
    positions.forEach((p, i) => {
      dummy.position.set(p.x, p.y + p.scale * FOLIAGE.farUndergrowthYOffset, p.z);
      dummy.scale.setScalar(p.scale);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
    return mesh;
  }
}
