import * as THREE from 'three';
import { SeededRandom, combineSeed } from '../utils/Random';
import { CLEARINGS, WORLD } from '../config';
import type { Terrain } from './Terrain';
import type { Biomes } from './Biomes';

/**
 * Campfire clearings — small open spots on flat grassland where a fire ring
 * sits and the surrounding trees/grass pull back.
 *
 * The decision is a *pure* function of seed + chunk coords + terrain/biomes, so
 * the vegetation streamer and the interactable spawner independently agree on
 * exactly where a clearing is (no shared state, no ordering between systems).
 * A clearing always lands well inside its chunk, so a neighbour chunk's trees
 * never need to know about it.
 */
export interface Clearing {
  x: number;
  z: number;
  /** trees are kept out to here */
  radius: number;
}

const CLEARING_CHANCE = CLEARINGS.spawnChance;
export const CLEARING_RADIUS = CLEARINGS.treeRadius;
export const CLEARING_BARE_RADIUS = CLEARINGS.bareRadius;

const _normal = new THREE.Vector3();

/** The clearing for a chunk, or null if this chunk has none. */
export function clearingForChunk(
  seed: number,
  cx: number,
  cz: number,
  terrain: Terrain,
  biomes: Biomes,
): Clearing | null {
  const rng = new SeededRandom(combineSeed(seed, cx, cz, 0xc1ea7));
  if (!rng.chance(CLEARING_CHANCE)) return null;

  const size = WORLD.chunkSize;
  // A few candidate spots; the clearing only forms on genuinely flat, dry,
  // open grassland — never in water, deep forest, on slopes, or up high.
  for (let attempt = 0; attempt < 5; attempt++) {
    const x = cx * size + rng.range(CLEARINGS.placementMin, CLEARINGS.placementMax) * size;
    const z = cz * size + rng.range(CLEARINGS.placementMin, CLEARINGS.placementMax) * size;
    const h = terrain.getHeightAt(x, z);
    if (h < WORLD.waterLevel + CLEARINGS.minWaterClearance || h > CLEARINGS.maxHeight) continue;
    terrain.getNormalAt(x, z, _normal);
    if (_normal.y < CLEARINGS.minSlopeNormal) continue;
    if (biomes.getGrassFactor(x, z, h, _normal.y) < CLEARINGS.minGrassFactor) continue;
    if (biomes.getForestMask(x, z) > CLEARINGS.maxForestMask) continue;
    return { x, z, radius: CLEARING_RADIUS };
  }
  return null;
}
