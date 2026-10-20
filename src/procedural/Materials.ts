import * as THREE from 'three';
import {
  createBarkTexture,
  createGroundDetailTexture,
  createRockTexture,
} from './Textures';
import type { SnowTrail } from '../world/SnowTrail';
import { WorldPalette } from '../settings/Palette';

/**
 * Shared, procedurally textured PBR materials. Built once per world and
 * reused by every chunk so material count stays tiny.
 */
export class MaterialLibrary {
  readonly terrain: THREE.MeshStandardMaterial;
  readonly bark: THREE.MeshStandardMaterial;
  readonly barkBirch: THREE.MeshStandardMaterial;
  readonly deadWood: THREE.MeshStandardMaterial;
  readonly rock: THREE.MeshStandardMaterial;
  readonly stone: THREE.MeshStandardMaterial;
  readonly log: THREE.MeshStandardMaterial;
  readonly crate: THREE.MeshStandardMaterial;
  readonly charcoal: THREE.MeshStandardMaterial;
  readonly ancientStone: THREE.MeshStandardMaterial;
  readonly crystal: THREE.MeshStandardMaterial;
  readonly bone: THREE.MeshStandardMaterial;
  readonly mossStone: THREE.MeshStandardMaterial;

  private disposables: Array<{ dispose(): void }> = [];

  constructor(seed: number, snowTrail?: SnowTrail) {
    const groundDetail = createGroundDetailTexture(seed);
    groundDetail.repeat.set(24, 24);

    this.terrain = new THREE.MeshStandardMaterial({
      vertexColors: true,
      map: groundDetail,
      // Per-pixel bump from the detail texture breaks up flat triangle
      // shading on steep rock faces (hides mesh faceting up close).
      bumpMap: groundDetail,
      bumpScale: 0.55,
      roughness: 0.96,
      metalness: 0,
    });
    if (snowTrail) this.wireSnowTrail(this.terrain, snowTrail);

    const barkTex = createBarkTexture(seed, WorldPalette.BARK);
    barkTex.repeat.set(1.6, 2.5);
    this.bark = new THREE.MeshStandardMaterial({ map: barkTex, roughness: 0.92 });

    const birchTex = createBarkTexture(seed + 1, WorldPalette.BARK_BIRCH);
    birchTex.repeat.set(1.6, 2.5);
    this.barkBirch = new THREE.MeshStandardMaterial({ map: birchTex, roughness: 0.9 });

    const deadTex = createBarkTexture(seed + 2, WorldPalette.BARK_DEAD);
    this.deadWood = new THREE.MeshStandardMaterial({ map: deadTex, roughness: 0.95 });

    const rockTex = createRockTexture(seed);
    this.rock = new THREE.MeshStandardMaterial({ map: rockTex, roughness: 0.94 });
    this.rock.onBeforeCompile = (shader: THREE.WebGLProgramParametersWithUniforms) => {
      shader.uniforms.uMoistureScale = { value: 0.6 };
      shader.vertexShader =
        'varying float vMossBlend;\nattribute float aMossBlend;\n' + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvMossBlend = aMossBlend;',
      );
      shader.fragmentShader = 'varying float vMossBlend;\nuniform float uMoistureScale;\n' + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <dithering_fragment>',
        `#include <dithering_fragment>
      if (vMossBlend > 0.01) {
        vec3 mossAlbedo = vec3(0.18, 0.28, 0.12);
        float mossNoise = fract(sin(dot(vViewPosition.xz, vec2(127.1, 311.7))) * 43758.5);
        float mossVar = 0.85 + mossNoise * 0.3;
        gl_FragColor.rgb = mix(gl_FragColor.rgb, mossAlbedo * mossVar, vMossBlend * uMoistureScale);
      }`,
      );
    };
    this.rock.customProgramCacheKey = () => 'rockMoss';
    this.stone = new THREE.MeshStandardMaterial({ map: rockTex, roughness: 0.92 });

    const logTex = createBarkTexture(seed + 5, WorldPalette.LOG);
    this.log = new THREE.MeshStandardMaterial({ map: logTex, roughness: 0.95 });

    const crateTex = createBarkTexture(seed + 6, WorldPalette.CRATE);
    crateTex.repeat.set(2, 2);
    this.crate = new THREE.MeshStandardMaterial({ map: crateTex, roughness: 0.85 });

    this.charcoal = new THREE.MeshStandardMaterial({ color: 0x1d1a18, roughness: 1.0 });

    const ancientTex = createRockTexture(seed + 7);
    this.ancientStone = new THREE.MeshStandardMaterial({
      map: ancientTex,
      color: 0xa8a294,
      roughness: 0.9,
    });

    this.bone = new THREE.MeshStandardMaterial({
      color: 0xcfc4ad,
      roughness: 0.78,
    });

    const mossTex = createRockTexture(seed + 8);
    this.mossStone = new THREE.MeshStandardMaterial({
      map: mossTex,
      color: 0x8fa07c,
      roughness: 0.96,
    });

    this.crystal = new THREE.MeshStandardMaterial({
      color: 0x7fd4ff,
      emissive: 0x3fa8e0,
      emissiveIntensity: 1.4,
      roughness: 0.25,
      metalness: 0.1,
      transparent: true,
      opacity: 0.92,
    });

    this.disposables.push(
      groundDetail, barkTex, birchTex, deadTex, rockTex, logTex, crateTex, ancientTex, mossTex,
      this.terrain, this.bark, this.barkBirch, this.deadWood,
      this.rock, this.stone, this.log,
      this.crate, this.charcoal, this.ancientStone, this.crystal,
      this.bone, this.mossStone,
    );
  }

  /**
   * Snow trail deformation: the terrain vertex stage samples the moving
   * depression window (depressing snowy vertices), the fragment stage shades
   * the compacted trough slightly darker and bluer.
   */
  private wireSnowTrail(material: THREE.MeshStandardMaterial, snowTrail: SnowTrail): void {
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uTrailMap = snowTrail.uniforms.uTrailMap;
      shader.uniforms.uTrailRegion = snowTrail.uniforms.uTrailRegion;

      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
attribute float aSnow;
attribute float aLodAlpha;
uniform sampler2D uTrailMap;
uniform vec4 uTrailRegion; // origin x, origin z, 1/size, strength
varying float vTrail;
varying float vLodAlpha;`,
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
{
  vec4 trailWp = modelMatrix * vec4(transformed, 1.0);
  vec2 trailUv = (trailWp.xz - uTrailRegion.xy) * uTrailRegion.z;
  float inWindow =
    step(abs(trailUv.x - 0.5), 0.5) * step(abs(trailUv.y - 0.5), 0.5);
  float depression = texture2D(uTrailMap, clamp(trailUv, 0.0, 1.0)).a;
  vTrail = depression * inWindow * aSnow * uTrailRegion.w;
  transformed.y -= vTrail * 0.22;
}
vLodAlpha = aLodAlpha;`,
        );

      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
varying float vTrail;
varying float vLodAlpha;
const float _BAYER[16]=float[16](0.0/16.0,8.0/16.0,2.0/16.0,10.0/16.0,12.0/16.0,4.0/16.0,14.0/16.0,6.0/16.0,3.0/16.0,11.0/16.0,1.0/16.0,9.0/16.0,15.0/16.0,7.0/16.0,13.0/16.0,5.0/16.0);`,
        )
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
{ float _b=_BAYER[int(mod(gl_FragCoord.x,4.0))*4+int(mod(gl_FragCoord.y,4.0))]; if(vLodAlpha<_b+0.001)discard; }
diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.62, 0.68, 0.84), vTrail);`,
        );
    };
    material.customProgramCacheKey = () => 'terrainSnowTrail';
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
  }
}
