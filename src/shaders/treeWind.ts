/**
 * Shared tree wind: bend from the trunk base in instance-local space so
 * foliage stays wrapped on the trunk regardless of tree yaw/lean.
 */

import * as THREE from 'three';
import type { SharedEnvUniforms } from '../world/Environment';

export const TREE_WIND_UNIFORMS = /* glsl */ `
uniform float uTime;
uniform vec2 uWindDir;
uniform float uWindStrength;
`;

/** GLSL helper; call after `transformed = vec3(position)` with local `position`. */
export const TREE_WIND_FN = /* glsl */ `
vec3 treeWindLocalDir() {
  vec3 worldWind = vec3(uWindDir.x, 0.0, uWindDir.y);
  #ifdef USE_INSTANCING
    mat3 instMat = mat3(instanceMatrix);
    vec3 localWind = vec3(
      dot(instMat[0].xyz, worldWind),
      0.0,
      dot(instMat[2].xyz, worldWind)
    );
    float len = length(localWind);
    return len > 1e-5 ? localWind / len * length(worldWind) : worldWind;
  #else
    return worldWind;
  #endif
}

vec4 treeWorldOrigin() {
  #ifdef USE_INSTANCING
    return modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  #else
    return modelMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  #endif
}

float treeWindSway(vec4 worldOrigin) {
  float phase = worldOrigin.x * 0.31 + worldOrigin.z * 0.27;
  return (sin(uTime * 1.1 + phase) * 0.6 + sin(uTime * 0.47 + phase * 1.9) * 0.4)
       * uWindStrength * 0.55;
}

void applyTreeWind(vec3 localPos, inout vec3 transformed) {
  vec3 localWind = treeWindLocalDir();
  float heightT = clamp(localPos.y / 22.0, 0.0, 1.0);
  float sway = treeWindSway(treeWorldOrigin()) * heightT;
  vec3 axis = normalize(vec3(-localWind.z, 0.0, localWind.x));
  float angle = sway * 0.045;
  float c = cos(angle);
  float s = sin(angle);
  vec3 p = transformed;
  transformed = p * c + cross(axis, p) * s + axis * dot(axis, p) * (1.0 - c);
}
`;

export const TREE_WIND_APPLY = /* glsl */ `
{
  applyTreeWind(position, transformed);
}
`;

const BAYER_MATRIX = `
const float BAYER[16] = float[16](
  0.0/16.0,  8.0/16.0,  2.0/16.0, 10.0/16.0,
  12.0/16.0, 4.0/16.0, 14.0/16.0,  6.0/16.0,
  3.0/16.0, 11.0/16.0,  1.0/16.0,  9.0/16.0,
  15.0/16.0,  7.0/16.0, 13.0/16.0,  5.0/16.0
);
`;

const BAYER_VERT_DECL = `attribute float aLodAlpha;\nvarying float vLodAlpha;\n` + BAYER_MATRIX;
const BAYER_VERT_ASSIGN = `  vLodAlpha = aLodAlpha;\n`;
const BAYER_FRAG_DECL = `varying float vLodAlpha;\n` + BAYER_MATRIX;
const BAYER_DISCARD = `
  float _bayer = BAYER[int(mod(gl_FragCoord.x,4.0))*4+int(mod(gl_FragCoord.y,4.0))];
  if (vLodAlpha < _bayer + 0.001) discard;
`;

/** MeshStandardMaterial clone that bends with the same wind as leaf cards. */
export function createWindTrunkMaterial(
  base: THREE.MeshStandardMaterial,
  env: Pick<SharedEnvUniforms, 'uTime' | 'uWindDir' | 'uWindStrength'>,
): THREE.MeshStandardMaterial {
  const material = base.clone();
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = env.uTime;
    shader.uniforms.uWindDir = env.uWindDir;
    shader.uniforms.uWindStrength = env.uWindStrength;

    shader.vertexShader = `${TREE_WIND_UNIFORMS}\n${TREE_WIND_FN}\n${BAYER_VERT_DECL}\n${shader.vertexShader}`;
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>\n${TREE_WIND_APPLY}`,
    );
    shader.vertexShader = shader.vertexShader.replace('void main() {', 'void main() {\n' + BAYER_VERT_ASSIGN);

    shader.fragmentShader = BAYER_FRAG_DECL + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace(
      'void main() {',
      'void main() {\n' + BAYER_DISCARD,
    );
  };
  material.customProgramCacheKey = () => 'treeWindTrunk';
  return material;
}
