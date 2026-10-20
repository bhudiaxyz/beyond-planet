/**
 * Typed access to the editable global defaults file. Keep existing named
 * exports stable so systems consume one configuration source without knowing
 * about JSON loading.
 */
import defaults from './settings/defaults.json';

export type QualityLevel = 'low' | 'medium' | 'high';

export interface QualitySettings {
  maxPixelRatio: number;
  antialias: boolean;
  shadowsEnabled: boolean;
  shadowMapSize: number;
  viewRadius: number;
  detailRadius: number;
  grassDensity: number;
  treeDensityScale: number;
  propDensityScale: number;
  terrainSegments: number;
  leafDensityScale: number;
  rainParticles: number;
}

interface GlobalDefaults {
  quality: {
    forcedLevel: QualityLevel | null;
    autoDetect: {
      highMinCores: number;
      highMinMemoryGb: number;
      mediumMinCores: number;
    };
    presets: Record<QualityLevel, QualitySettings>;
  };
  world: typeof defaults.world;
  player: typeof defaults.player;
  camera: typeof defaults.camera;
  renderer: typeof defaults.renderer;
  atmosphere: typeof defaults.atmosphere;
  dayNight: typeof defaults.dayNight;
  weather: typeof defaults.weather;
  grass: typeof defaults.grass;
  foliage: typeof defaults.foliage;
  nightSky: typeof defaults.nightSky;
  streaming: typeof defaults.streaming;
  farTerrain: typeof defaults.farTerrain;
  water: typeof defaults.water;
  snowTrail: typeof defaults.snowTrail;
  structures: typeof defaults.structures;
  drone: typeof defaults.drone;
  glow: typeof defaults.glow;
  interactables: typeof defaults.interactables;
  props: typeof defaults.props;
  game: typeof defaults.game;
  clearings: typeof defaults.clearings;
  hud: typeof defaults.hud;
  caves: typeof defaults.caves;
}

export const GLOBAL_DEFAULTS = defaults as GlobalDefaults;
export const QUALITY_PRESETS = GLOBAL_DEFAULTS.quality.presets;
export const FORCED_QUALITY = GLOBAL_DEFAULTS.quality.forcedLevel;
export const WORLD = GLOBAL_DEFAULTS.world;
export const PLAYER = GLOBAL_DEFAULTS.player;
export const CAMERA = GLOBAL_DEFAULTS.camera;
export const RENDERER = GLOBAL_DEFAULTS.renderer;
export const ATMOSPHERE = GLOBAL_DEFAULTS.atmosphere;
export const DAYNIGHT = GLOBAL_DEFAULTS.dayNight;
export const WEATHER = GLOBAL_DEFAULTS.weather;
export const GRASS = GLOBAL_DEFAULTS.grass;
export const FOLIAGE = GLOBAL_DEFAULTS.foliage;
export const NIGHT_SKY = GLOBAL_DEFAULTS.nightSky;
export const STREAMING = GLOBAL_DEFAULTS.streaming;
export const FAR_TERRAIN = GLOBAL_DEFAULTS.farTerrain;
export const WATER = GLOBAL_DEFAULTS.water;
export const SNOW_TRAIL = GLOBAL_DEFAULTS.snowTrail;
export const STRUCTURES = GLOBAL_DEFAULTS.structures;
export const DRONE = GLOBAL_DEFAULTS.drone;
export const GLOW = GLOBAL_DEFAULTS.glow;
export const INTERACTABLES_CFG = GLOBAL_DEFAULTS.interactables;
export const PROPS = GLOBAL_DEFAULTS.props;
export const GAME = GLOBAL_DEFAULTS.game;
export const CLEARINGS = GLOBAL_DEFAULTS.clearings;
export const HUD = GLOBAL_DEFAULTS.hud;
export const CAVES = GLOBAL_DEFAULTS.caves;

/** Cheap heuristic for an initial quality level. */
export function detectQuality(): QualityLevel {
  const cores = navigator.hardwareConcurrency ?? 4;
  const memory = (navigator as unknown as { deviceMemory?: number }).deviceMemory ?? 8;
  const auto = GLOBAL_DEFAULTS.quality.autoDetect;
  if (cores >= auto.highMinCores && memory >= auto.highMinMemoryGb) return 'high';
  if (cores >= auto.mediumMinCores) return 'medium';
  return 'low';
}
