import * as THREE from 'three';
import { ATMOSPHERE, CAVES, DAYNIGHT, WEATHER, type QualitySettings } from '../config';
import { SeededRandom, combineSeed, generateRandomSeed } from '../utils/Random';
import { clamp, lerp, smoothstep } from '../utils/MathUtils';
import type { Sky } from './Sky';
import { WorldPalette } from '../settings/Palette';

/** Uniform objects shared by reference with grass / leaf / water materials. */
export interface SharedEnvUniforms {
  uTime: { value: number };
  uWindDir: { value: THREE.Vector2 };
  uWindStrength: { value: number };
  uSunDir: { value: THREE.Vector3 };
  uSunColor: { value: THREE.Color };
  uAmbientColor: { value: THREE.Color };
  uGroundBounceColor: { value: THREE.Color };
  uZenithColor: { value: THREE.Color };
  uHorizonColor: { value: THREE.Color };
  uNight: { value: number };
  uCloudCover: { value: number };
  uStarAngle: { value: number };
  uDawnDusk: { value: number };
  uOvercastTint: { value: THREE.Color };
  uAuroraStrength: { value: number };
}

interface WeatherState {
  cloudCover: number;
  cloudDark: number;
  wind: number;
  fogMult: number;
  rain: number;
}

const WEATHER_STATES = WEATHER.states as Record<string, WeatherState>;
export const WEATHER_OPTIONS = Object.keys(WEATHER_STATES);
const WEATHER_KEYS = Object.keys(WEATHER_STATES);
const WEATHER_WEIGHTS = WEATHER.weights;
const CLOUD_FOG_COLOR   = WorldPalette.CLOUD_FOG;
const NIGHT_GROUND_COLOR = WorldPalette.NIGHT_GROUND;
const DUSK_GROUND_COLOR  = WorldPalette.DUSK_GROUND;
const PROBE_DIRECTIONS = [
  new THREE.Vector3(0, 1, 0),
  new THREE.Vector3(0.894, 0.447, 0),
  new THREE.Vector3(-0.894, 0.447, 0),
  new THREE.Vector3(0, 0.447, 0.894),
  new THREE.Vector3(0, 0.447, -0.894),
  new THREE.Vector3(0.894, -0.447, 0),
  new THREE.Vector3(-0.894, -0.447, 0),
  new THREE.Vector3(0, -0.447, 0.894),
  new THREE.Vector3(0, -0.447, -0.894),
  new THREE.Vector3(0, -1, 0),
] as const;
const PROBE_BASIS = PROBE_DIRECTIONS.map((direction) => {
  const basis = new Array<number>(9);
  THREE.SphericalHarmonics3.getBasisAt(direction, basis);
  return basis;
});

function pickWeatherKey(rng: SeededRandom): string {
  let r = rng.next();
  for (let i = 0; i < WEATHER_KEYS.length; i++) {
    r -= WEATHER_WEIGHTS[i];
    if (r <= 0) return WEATHER_KEYS[i];
  }
  return WEATHER_KEYS[0];
}

const PAL = WorldPalette.SKY;

/**
 * Environment director: advances time of day, drives the sun/moon, blends
 * sky/fog/light palettes through dawn-day-dusk-night, runs a procedural
 * weather state machine (clouds, wind, fog, rain), animates a global wind
 * field shared by grass/leaves/water, and carries the player's night torch.
 */
export class Environment {
  readonly uniforms: SharedEnvUniforms;

  /** Time of day [0..1): 0 midnight, 0.25 sunrise, 0.5 noon, 0.75 sunset. */
  timeOfDay: number;
  weatherName = 'clear';
  nightFactor = 0;
  inCave = false;

  private sunLight: THREE.DirectionalLight;
  private fillLight: THREE.DirectionalLight;
  private hemiLight: THREE.HemisphereLight;
  private diffuseProbe: THREE.LightProbe;
  private torch: THREE.PointLight;
  private shadowTarget = new THREE.Object3D();

  private fog: THREE.FogExp2;
  private weather: WeatherState = { ...WEATHER_STATES.clear };
  private targetWeather: WeatherState = { ...WEATHER_STATES.clear };
  private weatherTimer = 20;
  private weatherRng: SeededRandom;
  private windAngle = 0.6;
  private windVariation = 1;
  private dayCycleScale = 1;
  private fogScale = 1;
  private lightScale = ATMOSPHERE.lightScaleDefault;
  private probeTimer = 0;
  private autoWeather = true;
  private rain: THREE.Points;
  private rainMaterial: THREE.ShaderMaterial;

  private auroraStrengthTarget = 0;
  private lastNightFactor = 0;
  private _caveBlend = 0;
  /** Smoothed 0→1 as player enters a cave; consumed by World for fog blending. */
  get caveBlend(): number { return this._caveBlend; }

  // Scratch
  private sunDirRaw = new THREE.Vector3();
  private moonDir = new THREE.Vector3();
  private colB = new THREE.Color();
  private probeColor = new THREE.Color();
  private groundBounceColor = new THREE.Color();
  private _blendScratch = new THREE.Color();
  private _overcastGrey = new THREE.Color(0.52, 0.55, 0.58);
  private _overcastWhite = new THREE.Color(1, 1, 1);

  constructor(
    private scene: THREE.Scene,
    private sky: Sky,
    seed: number,
    quality: QualitySettings,
  ) {
    this.weatherRng = new SeededRandom(combineSeed(seed, 555));
    const sessionRng = new SeededRandom(generateRandomSeed());
    this.timeOfDay = sessionRng.next();

    const initialWeather = pickWeatherKey(sessionRng);
    this.weather = { ...WEATHER_STATES[initialWeather] };
    this.targetWeather = { ...WEATHER_STATES[initialWeather] };
    this.weatherName = initialWeather;
    this.windVariation = sessionRng.range(WEATHER.windVariationMin, WEATHER.windVariationMax);
    this.weatherTimer = this.weatherRng.range(WEATHER.changeIntervalMin, WEATHER.changeIntervalMax);

    // URL overrides preserve deterministic testing despite session-random
    // default time and weather.
    const params = new URLSearchParams(window.location.search);
    const tod = params.get('tod');
    if (tod !== null) {
      const forcedTime = parseFloat(tod);
      if (Number.isFinite(forcedTime)) this.timeOfDay = clamp(forcedTime, 0, 0.9999);
    }
    const wx = params.get('weather');
    if (wx && WEATHER_STATES[wx]) {
      this.weather = { ...WEATHER_STATES[wx] };
      this.targetWeather = { ...WEATHER_STATES[wx] };
      this.weatherName = wx;
    }
    this.uniforms = {
      uTime: { value: 0 },
      uWindDir: { value: new THREE.Vector2(1, 0.3).normalize() },
      uWindStrength: { value: 0.4 },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunColor: { value: new THREE.Color(0xfff3d8) },
      uAmbientColor: { value: new THREE.Color(0x6f7a86) },
      uGroundBounceColor: { value: new THREE.Color(0x66704a) },
      uZenithColor: { value: new THREE.Color(0x2f6cb0) },
      uHorizonColor: { value: new THREE.Color(0xa8c2d4) },
      uNight: { value: 0 },
      uCloudCover: { value: 0.2 },
      uStarAngle: { value: 0 },
      uDawnDusk:      { value: 0 },
      uOvercastTint:  { value: new THREE.Color(1, 1, 1) },
      uAuroraStrength:{ value: 0 },
    };

    // --- Lights ---
    this.sunLight = new THREE.DirectionalLight(0xfff3d8, ATMOSPHERE.sunIntensity);
    this.sunLight.castShadow = quality.shadowsEnabled;
    if (quality.shadowsEnabled) {
      const cam = this.sunLight.shadow.camera;
      const extent = ATMOSPHERE.shadowExtent;
      cam.left = -extent;
      cam.right = extent;
      cam.top = extent;
      cam.bottom = -extent;
      cam.near = 1;
      cam.far = ATMOSPHERE.shadowCamFar;
      this.sunLight.shadow.mapSize.set(quality.shadowMapSize, quality.shadowMapSize);
      this.sunLight.shadow.bias = ATMOSPHERE.shadowBias;
      this.sunLight.shadow.normalBias = ATMOSPHERE.shadowNormalBias;
      this.sunLight.shadow.radius = ATMOSPHERE.shadowRadius;
    }
    scene.add(this.sunLight);
    scene.add(this.shadowTarget);
    this.sunLight.target = this.shadowTarget;

    // Shadowless fill from the opposite side: lifts shadow sides so they
    // read as soft sky-bounce instead of pure black.
    this.fillLight = new THREE.DirectionalLight(0x9db8d6, ATMOSPHERE.fillIntensity);
    scene.add(this.fillLight);
    scene.add(this.fillLight.target);

    this.hemiLight = new THREE.HemisphereLight(0x9db8d6, 0x6e6750, ATMOSPHERE.hemiIntensity);
    scene.add(this.hemiLight);

    // Directional diffuse IBL for sky, horizon, and terrain bounce. Unlike
    // flat ambient light, the probe preserves form inside cast shadows.
    this.diffuseProbe = new THREE.LightProbe(undefined, 1.1);
    scene.add(this.diffuseProbe);

    // Night torch: warm point light hovering with the player.
    this.torch = new THREE.PointLight(DAYNIGHT.torchColor, 0, DAYNIGHT.torchDistance, 1.7);
    scene.add(this.torch);

    // --- Fog ---
    this.fog = new THREE.FogExp2(0xb9c6cf, ATMOSPHERE.fogDensity);
    scene.fog = this.fog;
    scene.background = new THREE.Color(0xb9c6cf);

    // --- Rain particle system ---
    const rainBuilt = this.buildRain(quality.rainParticles);
    this.rain = rainBuilt.points;
    this.rainMaterial = rainBuilt.material;
    scene.add(this.rain);
  }

  private buildRain(count: number): { points: THREE.Points; material: THREE.ShaderMaterial } {
    const offsets = new Float32Array(count * 3);
    const speeds = new Float32Array(count);
    const rng = new SeededRandom(8181);
    for (let i = 0; i < count; i++) {
      offsets[i * 3] = rng.next();
      offsets[i * 3 + 1] = rng.next();
      offsets[i * 3 + 2] = rng.next();
      speeds[i] = rng.range(WEATHER.rainSpeedMin, WEATHER.rainSpeedMax);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(offsets, 3));
    geo.setAttribute('aSpeed', new THREE.BufferAttribute(speeds, 1));

    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: {
        uTime: this.uniforms.uTime,
        uCamPos: { value: new THREE.Vector3() },
        uOpacity: { value: 0 },
        uWindDir: this.uniforms.uWindDir,
        uWindStrength: this.uniforms.uWindStrength,
      },
      vertexShader: /* glsl */ `
        uniform float uTime;
        uniform vec3 uCamPos;
        uniform vec2 uWindDir;
        uniform float uWindStrength;
        attribute float aSpeed;
        varying float vFade;

        const vec3 BOX = vec3(70.0, 42.0, 70.0);

        void main() {
          vec3 p = position * BOX;
          // Endless fall: wrap inside a box glued to the camera.
          p.y = mod(p.y - uTime * aSpeed, BOX.y);
          // Wind slant.
          p.xz += uWindDir * uWindStrength * (BOX.y - p.y) * 0.35;
          vec3 world = uCamPos + p - BOX * 0.5;
          vec4 mv = viewMatrix * vec4(world, 1.0);
          gl_Position = projectionMatrix * mv;
          float dist = -mv.z;
          gl_PointSize = clamp(110.0 / dist, 1.5, 7.0);
          vFade = smoothstep(70.0, 25.0, dist);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uOpacity;
        varying float vFade;
        void main() {
          vec2 pc = gl_PointCoord - 0.5;
          // Vertical streak.
          float a = (1.0 - smoothstep(0.0, 0.16, abs(pc.x))) * (1.0 - smoothstep(0.3, 0.5, abs(pc.y)));
          gl_FragColor = vec4(vec3(0.62, 0.68, 0.76), a * uOpacity * vFade * 0.55);
        }
      `,
    });

    const points = new THREE.Points(geo, material);
    points.frustumCulled = false;
    points.renderOrder = 5;
    return { points, material };
  }

  private pickWeather(): void {
    this.weatherName = pickWeatherKey(this.weatherRng);
    this.targetWeather = { ...WEATHER_STATES[this.weatherName] };
  }

  randomizeConditions(): void {
    const rng = new SeededRandom(generateRandomSeed());
    // Time of day is not randomized — it advances 4 hours (and wraps), so
    // repeated presses walk the day forward instead of teleporting around it.
    this.timeOfDay = (this.timeOfDay + 4 / 24) % 1;
    this.weatherName = pickWeatherKey(rng);
    this.weather = { ...WEATHER_STATES[this.weatherName] };
    this.targetWeather = { ...WEATHER_STATES[this.weatherName] };
    this.windAngle = rng.range(0, Math.PI * 2);
    this.windVariation = rng.range(WEATHER.windVariationMin, WEATHER.windVariationMax);
    this.weatherTimer = rng.range(WEATHER.changeIntervalMin, WEATHER.changeIntervalMax);
  }

  getControlState() {
    return {
      timeOfDay: this.timeOfDay,
      weather: this.weatherName,
      autoWeather: this.autoWeather,
      cycleScale: this.dayCycleScale,
      cloudCover: this.weather.cloudCover,
      cloudDark: this.weather.cloudDark,
      rain: this.weather.rain,
      windStrength: this.windVariation,
      windDirection: ((this.windAngle * 180) / Math.PI + 360) % 360,
      fogScale: this.fogScale,
      lightScale: this.lightScale,
    };
  }

  setTimeOfDay(value: number): void {
    this.timeOfDay = clamp(value, 0, 0.9999);
  }

  setDayCycleScale(value: number): void {
    this.dayCycleScale = clamp(value, 0, 8);
  }

  setAutoWeather(enabled: boolean): void {
    this.autoWeather = enabled;
  }

  setWeather(name: string): void {
    if (!WEATHER_STATES[name]) return;
    this.autoWeather = false;
    this.weatherName = name;
    this.weather = { ...WEATHER_STATES[name] };
    this.targetWeather = { ...WEATHER_STATES[name] };
  }

  setWeatherValue(key: 'cloudCover' | 'cloudDark' | 'rain', value: number): void {
    const clamped = clamp(value, 0, 1);
    this.weather[key] = clamped;
    this.targetWeather[key] = clamped;
    this.autoWeather = false;
    this.weatherName = 'custom';
  }

  setWindStrength(value: number): void {
    this.windVariation = clamp(value, 0, 2.5);
  }

  setWindDirection(degrees: number): void {
    this.windAngle = (degrees * Math.PI) / 180;
  }

  setFogScale(value: number): void {
    this.fogScale = clamp(value, 0.2, 3);
  }

  setLightScale(value: number): void {
    this.lightScale = clamp(value, ATMOSPHERE.lightScaleMin, ATMOSPHERE.lightScaleMax);
  }

  resetControlModifiers(): void {
    this.dayCycleScale = 1;
    this.fogScale = 1;
    this.lightScale = ATMOSPHERE.lightScaleDefault;
    this.windVariation = 1;
    this.autoWeather = true;
  }

  update(dt: number, elapsed: number, camera: THREE.PerspectiveCamera): void {
    const u = this.uniforms;
    u.uTime.value = elapsed;

    // --- Advance the day ---
    this.timeOfDay = (this.timeOfDay + (dt * this.dayCycleScale) / DAYNIGHT.dayLengthSeconds) % 1;
    const angle = (this.timeOfDay - 0.25) * Math.PI * 2; // sunrise at 0.25
    this.sunDirRaw.set(Math.cos(angle) * 0.9, Math.sin(angle), 0.42).normalize();
    this.moonDir.copy(this.sunDirRaw).negate();
    const sunY = this.sunDirRaw.y;

    // 5-slot palette blend weights (timeOfDay: 0=midnight, 0.25=sunrise, 0.5=noon, 0.75=sunset)
    const t = this.timeOfDay;
    const wNight   = smoothstep(0.10, 0.0, t) + smoothstep(0.90, 1.0, t);
    const wDawn    = smoothstep(0.16, 0.22, t) * smoothstep(0.32, 0.25, t);
    const wDay     = smoothstep(0.28, 0.38, t) * smoothstep(0.68, 0.58, t);
    const wDusk    = smoothstep(0.68, 0.74, t) * smoothstep(0.84, 0.78, t);
    const wEvening = smoothstep(0.80, 0.87, t) * smoothstep(0.96, 0.90, t);
    const wSum = wNight + wDawn + wDay + wDusk + wEvening + 1e-6;
    const nNight = wNight / wSum;
    const nDawn = wDawn / wSum;
    const nDay = wDay / wSum;
    const nDusk = wDusk / wSum;
    const nEvening = wEvening / wSum;

    // Keep downstream code that uses day/night/dusk weights working.
    const day = nDay;
    const night = nNight + nEvening * 0.5;
    const dusk = (wDusk + wDawn) / wSum;
    this.nightFactor = nNight + nEvening * 0.5;
    u.uNight.value = night;

    // Roll aurora once per night entry
    if (this.nightFactor > 0.8 && this.lastNightFactor <= 0.8) {
      const roll = this.weatherRng.next();
      this.auroraStrengthTarget =
        roll < ATMOSPHERE.auroraNoChance    ? 0 :
        roll < ATMOSPHERE.auroraFaintMaxRoll ? this.weatherRng.next() * ATMOSPHERE.auroraFaintRange + ATMOSPHERE.auroraFaintMin :
                                               this.weatherRng.next() * ATMOSPHERE.auroraStrongRange + ATMOSPHERE.auroraStrongMin;
    }
    this.lastNightFactor = this.nightFactor;
    u.uAuroraStrength.value +=
      (this.auroraStrengthTarget * this.nightFactor - u.uAuroraStrength.value) * Math.min(1, dt * ATMOSPHERE.auroraLerpRate);

    const blendField = (field: keyof typeof PAL.day): THREE.Color => {
      const c = this._blendScratch.set(0, 0, 0);
      c.r += PAL.night[field].r * nNight;
      c.g += PAL.night[field].g * nNight;
      c.b += PAL.night[field].b * nNight;
      c.r += PAL.dawn[field].r * nDawn;
      c.g += PAL.dawn[field].g * nDawn;
      c.b += PAL.dawn[field].b * nDawn;
      c.r += PAL.day[field].r * nDay;
      c.g += PAL.day[field].g * nDay;
      c.b += PAL.day[field].b * nDay;
      c.r += PAL.dusk[field].r * nDusk;
      c.g += PAL.dusk[field].g * nDusk;
      c.b += PAL.dusk[field].b * nDusk;
      c.r += PAL.evening[field].r * nEvening;
      c.g += PAL.evening[field].g * nEvening;
      c.b += PAL.evening[field].b * nEvening;
      return c;
    };

    u.uDawnDusk.value = Math.min(1, (wDawn + wDusk) / wSum * 3.5);

    // --- Weather state machine ---
    this.weatherTimer -= this.autoWeather ? dt : 0;
    if (this.autoWeather && this.weatherTimer <= 0) {
      this.weatherTimer = this.weatherRng.range(WEATHER.changeIntervalMin, WEATHER.changeIntervalMax);
      this.pickWeather();
    }
    const k = 1 - Math.exp(-WEATHER.blendRate * dt);
    const w = this.weather;
    w.cloudCover = lerp(w.cloudCover, this.targetWeather.cloudCover, k);
    w.cloudDark = lerp(w.cloudDark, this.targetWeather.cloudDark, k);
    w.wind = lerp(w.wind, this.targetWeather.wind, k);
    w.fogMult = lerp(w.fogMult, this.targetWeather.fogMult, k);
    w.rain = lerp(w.rain, this.targetWeather.rain, k);

    // --- Wind: slowly veering direction + gusting strength ---
    this.windAngle += dt * WEATHER.windAngleDriftRate;
    const gust =
      0.72 +
      0.28 * Math.sin(elapsed * 0.5) * Math.sin(elapsed * 0.23 + 1.7) +
      0.18 * Math.sin(elapsed * 1.31 + 0.4);
    u.uWindDir.value.set(Math.cos(this.windAngle), Math.sin(this.windAngle));
    u.uWindStrength.value = w.wind * this.windVariation * gust;

    // --- Palette blending ---
    const cloudMute = 1 - w.cloudDark * 0.55; // storms desaturate the light

    u.uZenithColor.value.copy(blendField('zenith'));
    u.uHorizonColor.value.copy(blendField('horizon'));
    u.uSunColor.value.copy(blendField('sun'));

    // Fog: weather thickens it; night darkens it.
    this.colB.copy(blendField('fog'));
    this.colB.lerp(CLOUD_FOG_COLOR, w.cloudDark * 0.5 * (1 - night));
    this.fog.color.copy(this.colB);
    (this.scene.background as THREE.Color).copy(this.colB);
    this.fog.density =
      ATMOSPHERE.fogDensity * ATMOSPHERE.lodFogMult * this.fogScale * w.fogMult * (1 + night * 0.8);

    // uOvercastTint: grey shift under heavy cloud cover
    u.uOvercastTint.value.lerpColors(this._overcastWhite, this._overcastGrey, w.cloudCover * 0.55);

    // --- Night sky: celestial rotation and cloud visibility ---
    u.uStarAngle.value = this.timeOfDay * Math.PI * 2;
    u.uCloudCover.value = w.cloudCover;

    // --- Sky uniforms ---
    const sky = this.sky.material.uniforms;
    sky.uStarAngle.value = u.uStarAngle.value;
    sky.uSunDir.value.copy(this.sunDirRaw);
    sky.uMoonDir.value.copy(this.moonDir);
    (sky.uZenithColor.value as THREE.Color).copy(u.uZenithColor.value);
    (sky.uHorizonColor.value as THREE.Color).copy(u.uHorizonColor.value);
    (sky.uHazeColor.value as THREE.Color).copy(blendField('haze'));
    (sky.uSunColor.value as THREE.Color).copy(u.uSunColor.value);
    sky.uNight.value = night;
    sky.uCloudCover.value = w.cloudCover;
    sky.uCloudDark.value = w.cloudDark;
    (sky.uWind.value as THREE.Vector2).copy(u.uWindDir.value).multiplyScalar(2 + w.wind * 6);
    sky.uDawnDusk.value = u.uDawnDusk.value;
    (sky.uOvercastTint.value as THREE.Color).copy(u.uOvercastTint.value);
    sky.uAuroraStrength.value = u.uAuroraStrength.value;
    const stars = this.sky.starMaterial.uniforms;
    stars.uStarAngle.value = u.uStarAngle.value;
    stars.uNight.value = night;
    stars.uCloudCover.value = w.cloudCover;

    // --- Key light: sun by day, moon by night (one shadow light) ---
    const moonUp = sunY < 0.02;
    const lightDir = moonUp ? this.moonDir : this.sunDirRaw;
    u.uSunDir.value.copy(lightDir);

    const sunStrength = ATMOSPHERE.sunIntensity * day * (1 - w.cloudCover * 0.62) + dusk * ATMOSPHERE.duskSunStrengthMult * (1 - w.cloudCover * 0.5);
    const moonStrength = ATMOSPHERE.moonStrengthBase * night * (1 - w.cloudCover * 0.7);
    this.sunLight.intensity = (moonUp ? moonStrength : sunStrength) * cloudMute * this.lightScale;
    this.sunLight.color.copy(moonUp ? PAL.night.sun : (u.uSunColor.value as THREE.Color));

    // Ambient: hemisphere + fill scale with daylight but never reach zero.
    this.hemiLight.intensity =
      (ATMOSPHERE.hemiIntensity * day + 0.55 * dusk + 0.32 * night) *
      (1 - w.cloudDark * 0.25) *
      this.lightScale;
    this.hemiLight.color.copy(u.uHorizonColor.value);
    this.hemiLight.groundColor.setHex(0x6e6750).lerp(NIGHT_GROUND_COLOR, night);
    this.groundBounceColor
      .setHex(0x66704a)
      .lerp(DUSK_GROUND_COLOR, dusk * 0.55)
      .lerp(NIGHT_GROUND_COLOR, night * 0.8);
    u.uGroundBounceColor.value.copy(this.groundBounceColor);
    this.diffuseProbe.intensity = 1.1 * this.lightScale;
    this.probeTimer -= dt;
    if (this.probeTimer <= 0) {
      this.probeTimer = 0.1;
      this.updateDiffuseProbe(w.cloudDark, night);
    }

    this.fillLight.intensity =
      (ATMOSPHERE.fillIntensity * (0.35 + day * 0.65) * cloudMute + 0.12) * this.lightScale;
    this.fillLight.position.copy(camera.position).addScaledVector(lightDir, -120);
    this.fillLight.position.y = camera.position.y + 60;
    this.fillLight.target.position.copy(camera.position);

    // Cave light suppression: blend over ~2 s (driven by damp).
    this._caveBlend = THREE.MathUtils.damp(this._caveBlend, this.inCave ? 1 : 0, CAVES.caveBlendRate, dt);
    if (this._caveBlend > 0.001) {
      this.hemiLight.intensity *= 1 - this._caveBlend * CAVES.lightSuppressHemi;
      this.fillLight.intensity  *= 1 - this._caveBlend * CAVES.lightSuppressFill;
      this.torch.intensity      *= 1 + this._caveBlend * CAVES.lightBoostTorch;
    }

    // Ambient color uniform for grass/leaf shaders.
    // Blend ~38% zenith so this approximates the SH LightProbe's upper-hemisphere
    // irradiance — avoiding a tone mismatch vs terrain at dawn/dusk.
    (u.uAmbientColor.value as THREE.Color)
      .copy(u.uHorizonColor.value)
      .lerp(u.uZenithColor.value, 0.38)
      .multiplyScalar(0.72 + day * 0.3);

    // Shadow frustum follows the player, snapped to texels to avoid shimmer.
    const texel = 190 / this.sunLight.shadow.mapSize.x;
    const snap = texel;
    const tx = Math.round(camera.position.x / snap) * snap;
    const tz = Math.round(camera.position.z / snap) * snap;
    this.shadowTarget.position.set(tx, 0, tz);
    this.sunLight.position.set(
      tx + lightDir.x * 300,
      Math.max(lightDir.y, 0.12) * 300,
      tz + lightDir.z * 300,
    );

    // --- Torch: warm player light, night only, gentle flicker ---
    const flicker = 0.86 + 0.14 * Math.sin(elapsed * 11.0) * Math.sin(elapsed * 5.7 + 2.1);
    this.torch.intensity = DAYNIGHT.torchIntensity * night * flicker;
    this.torch.position.copy(camera.position);
    this.torch.position.y -= 0.4;

    // --- Rain follows the camera ---
    this.rainMaterial.uniforms.uOpacity.value = w.rain;
    (this.rainMaterial.uniforms.uCamPos.value as THREE.Vector3).copy(camera.position);
    this.rain.visible = w.rain > 0.02;
  }

  /** Project the current procedural environment into 3-band diffuse SH. */
  private updateDiffuseProbe(cloudDark: number, night: number): void {
    const coefficients = this.diffuseProbe.sh.coefficients;
    for (const coefficient of coefficients) coefficient.set(0, 0, 0);

    const weight = (4 * Math.PI) / PROBE_DIRECTIONS.length;
    const skyMute = 1 - cloudDark * 0.28;
    for (let sample = 0; sample < PROBE_DIRECTIONS.length; sample++) {
      const direction = PROBE_DIRECTIONS[sample];
      if (direction.y >= 0) {
        this.probeColor
          .copy(this.uniforms.uHorizonColor.value)
          .lerp(this.uniforms.uZenithColor.value, Math.pow(direction.y, 0.55))
          .multiplyScalar(skyMute);
      } else {
        const down = -direction.y;
        this.probeColor
          .copy(this.uniforms.uHorizonColor.value)
          .lerp(this.groundBounceColor, 0.48 + down * 0.4)
          .multiplyScalar((0.52 + (1 - down) * 0.2) * (1 - night * 0.32));
      }

      const basis = PROBE_BASIS[sample];
      for (let i = 0; i < coefficients.length; i++) {
        coefficients[i].x += basis[i] * this.probeColor.r * weight;
        coefficients[i].y += basis[i] * this.probeColor.g * weight;
        coefficients[i].z += basis[i] * this.probeColor.b * weight;
      }
    }
  }

}
