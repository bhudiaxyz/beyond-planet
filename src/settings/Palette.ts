import * as THREE from 'three';

/**
 * Central palette for all world colors.
 * Stored in sRGB; callers needing linear vertex colors should
 * call .clone().convertSRGBToLinear() on the value they use.
 */
export class WorldPalette {
  // ── Terrain / biome ground ─────────────────────────────────────────────
  static readonly GRASS_LUSH   = new THREE.Color(0x6d9444);
  static readonly GRASS_DRY    = new THREE.Color(0x9c9456);
  static readonly DIRT         = new THREE.Color(0x8a6b46);
  static readonly ROCK         = new THREE.Color(0x8d8880);
  static readonly ROCK_DARK    = new THREE.Color(0x6a6660);
  static readonly WET          = new THREE.Color(0x564f3a);
  static readonly SAND         = new THREE.Color(0xa89876);
  static readonly SNOW         = new THREE.Color(0xe6eaec);
  static readonly SNOW_BLUE    = new THREE.Color(0xaebdca);
  static readonly SNOW_SUN     = new THREE.Color(0xf6f3e8);

  // ── Vegetation instance tints ──────────────────────────────────────────
  static readonly GRASS_COOL   = new THREE.Color(0x17462f);
  static readonly GRASS_WARM   = new THREE.Color(0x9a7a2c);
  static readonly REED_TAN     = new THREE.Color(0x9B7A45);
  static readonly REED_BROWN   = new THREE.Color(0x8B6030);
  static readonly CACTUS_GREEN = new THREE.Color(0x4E7040);
  static readonly CACTUS_GRAY  = new THREE.Color(0x527055);

  // ── Bark / wood ────────────────────────────────────────────────────────
  static readonly BARK         = new THREE.Color(0x6e5740);
  static readonly BARK_BIRCH   = new THREE.Color(0x8d8678);
  static readonly BARK_DEAD    = new THREE.Color(0x6d6357);
  static readonly LOG          = new THREE.Color(0x4f4334);
  static readonly CRATE        = new THREE.Color(0x7a6244);

  // ── Cave ───────────────────────────────────────────────────────────────
  static readonly CAVE_ROCK          = new THREE.Color(0x5A6270);
  static readonly CAVE_FLOOR         = new THREE.Color(0x4A3E34);
  static readonly CAVE_FERN          = new THREE.Color(0x8BA89A);
  static readonly CAVE_GHOST_FLOWER  = new THREE.Color(0xE8E4DC);
  static readonly CAVE_MOSS          = new THREE.Color(0x2D3D2A);
  static readonly CAVE_POOL          = new THREE.Color(0x2D4A5A);
  static readonly CAVE_ENTRANCE_GLOW = new THREE.Color(0x8B7355);
  static readonly CAVE_FOG           = new THREE.Color(0x1A1E22);
  static readonly CAVE_CRYSTAL: Record<'shore' | 'grassland' | 'mountain', THREE.Color> = {
    shore:     new THREE.Color(0x8AB4D4),
    grassland: new THREE.Color(0xC4A35A),
    mountain:  new THREE.Color(0xA894CC),
  };

  // ── Water ──────────────────────────────────────────────────────────────
  static readonly WATER_SHALLOW = new THREE.Color(0x39595a);
  static readonly WATER_DEEP    = new THREE.Color(0x102530);

  // ── Atmosphere / fog ──────────────────────────────────────────────────
  static readonly CLOUD_FOG    = new THREE.Color(0x5a626c);
  static readonly NIGHT_GROUND = new THREE.Color(0x1c2026);
  static readonly DUSK_GROUND  = new THREE.Color(0x5b4033);

  // ── Sky time-of-day palette (sRGB, blended continuously) ──────────────
  static readonly SKY = {
    night:   { zenith: new THREE.Color(0x0a0c18), horizon: new THREE.Color(0x0d1020), haze: new THREE.Color(0x0b0e1c), sun: new THREE.Color(0x8892bb), fog: new THREE.Color(0x060810) },
    dawn:    { zenith: new THREE.Color(0x2a2858), horizon: new THREE.Color(0xe87030), haze: new THREE.Color(0xf0a050), sun: new THREE.Color(0xffd090), fog: new THREE.Color(0x1a1530) },
    day:     { zenith: new THREE.Color(0x1a4fa0), horizon: new THREE.Color(0x82b8e8), haze: new THREE.Color(0xb8d8f0), sun: new THREE.Color(0xfff5e0), fog: new THREE.Color(0x8ab4d8) },
    dusk:    { zenith: new THREE.Color(0x2e1e4a), horizon: new THREE.Color(0xe85820), haze: new THREE.Color(0xf0843c), sun: new THREE.Color(0xff9060), fog: new THREE.Color(0x1e1228) },
    evening: { zenith: new THREE.Color(0x0e1228), horizon: new THREE.Color(0x1a1e3c), haze: new THREE.Color(0x151830), sun: new THREE.Color(0xa0a8cc), fog: new THREE.Color(0x080c18) },
  };
}
