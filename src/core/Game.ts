import * as THREE from 'three';
import { Renderer } from './Renderer';
import { CameraController } from './CameraController';
import { Hud } from './Hud';
import { World } from '../world/World';
import { WEATHER_OPTIONS } from '../world/Environment';
import { InteractionSystem } from '../world/Interactables';
import {
  FORCED_QUALITY,
  GAME,
  QUALITY_PRESETS,
  RENDERER,
  detectQuality,
  type QualityLevel,
} from '../config';

const yieldToMain = (): Promise<void> => new Promise(r => setTimeout(r, 0));

/**
 * Game shell: wires the renderer, world, controller, HUD, and the main
 * requestAnimationFrame loop with separated update / render phases.
 */
export class Game {
  private renderer: Renderer;
  private world: World;
  private controller: CameraController;
  private hud: Hud;
  private interaction: InteractionSystem;
  private clock = new THREE.Clock();
  private qualityLevel: QualityLevel;

  // FPS tracking + adaptive resolution fallback.
  private fpsSmoothed = 60;
  private fpsHudTimer = 0;
  private lowFpsTime = 0;
  private statusTimer = 0;
  // The adaptive resolution drop only arms once the world has streamed in and
  // FPS has had a moment to settle — reacting to the transient startup load
  // would needlessly drop resolution and flash the canvas on every resize.
  private adaptiveArmed = false;
  private adaptiveSettle = 0;

  private running = false;

  private constructor(
    renderer: Renderer,
    world: World,
    controller: CameraController,
    hud: Hud,
    interaction: InteractionSystem,
    qualityLevel: QualityLevel,
  ) {
    this.renderer = renderer;
    this.world = world;
    this.controller = controller;
    this.hud = hud;
    this.interaction = interaction;
    this.qualityLevel = qualityLevel;
  }

  static async create(seed: number): Promise<Game> {
    const qualityLevel = FORCED_QUALITY ?? detectQuality();
    const quality = QUALITY_PRESETS[qualityLevel];
    const container = document.getElementById('app')!;

    const renderer = new Renderer(container, quality);
    const hud = new Hud();
    hud.setSeed(seed);
    hud.setQuality(qualityLevel);

    await yieldToMain();

    const world = new World(seed, quality, renderer.webgl);
    const controller = new CameraController(world.terrain, renderer.webgl.domElement);
    controller.caveNetwork = world.caves;
    renderer.configureOutput(world.scene, controller.camera, world.environment.uniforms);

    const spawn = world.findSpawn();
    controller.spawnAt(spawn.x, spawn.z);

    await yieldToMain();

    world.warmup(controller.camera.position);

    const interaction = new InteractionSystem(hud.promptEl, hud.messageEl);
    const game = new Game(renderer, world, controller, hud, interaction, qualityLevel);
    game._bind();
    return game;
  }

  private _bind(): void {
    this.hud.bindHackMenu({
      weatherOptions: WEATHER_OPTIONS,
      getState: () => ({
        ...this.world.environment.getControlState(),
        exposure: this.renderer.getExposure(),
        grassDensity: this.world.getGrassSettings().densityMultiplier,
        grassHeight: this.world.getGrassSettings().heightMultiplier,
        grassWidth: this.world.getGrassSettings().widthMultiplier,
        grassCoverage: 1 - this.world.getGrassSettings().coverageExponent,
        grassEdgeDensity: this.world.getGrassSettings().edgeDensityMultiplier,
        undergrowthDensity: this.world.getGrassSettings().undergrowthMultiplier,
      }),
      setTime: (value) => this.world.environment.setTimeOfDay(value),
      setCycleScale: (value) => this.world.environment.setDayCycleScale(value),
      setWeather: (value) => this.world.environment.setWeather(value),
      setAutoWeather: (value) => this.world.environment.setAutoWeather(value),
      setCloudCover: (value) => this.world.environment.setWeatherValue('cloudCover', value),
      setCloudDark: (value) => this.world.environment.setWeatherValue('cloudDark', value),
      setRain: (value) => this.world.environment.setWeatherValue('rain', value),
      setWindStrength: (value) => this.world.environment.setWindStrength(value),
      setWindDirection: (value) => this.world.environment.setWindDirection(value),
      setFogScale: (value) => this.world.environment.setFogScale(value),
      setLightScale: (value) => this.world.environment.setLightScale(value),
      setExposure: (value) => this.renderer.setExposure(value),
      setGrassDensity: (value) => this.world.setGrassSetting('densityMultiplier', value),
      setGrassHeight: (value) => this.world.setGrassSetting('heightMultiplier', value),
      setGrassWidth: (value) => this.world.setGrassSetting('widthMultiplier', value),
      setGrassCoverage: (value) => this.world.setGrassSetting('coverageExponent', 1 - value),
      setGrassEdgeDensity: (value) => this.world.setGrassSetting('edgeDensityMultiplier', value),
      setUndergrowthDensity: (value) => this.world.setGrassSetting('undergrowthMultiplier', value),
      randomize: () => this.shiftAtmosphere(),
      reset: () => {
        this.world.environment.resetControlModifiers();
        this.world.resetGrassSettings();
        this.renderer.setExposure(RENDERER.exposure);
      },
    });

    window.addEventListener('resize', () => this.renderer.handleResize(this.controller.camera));

    // ?stats=1: periodically log renderer stats for performance tuning.
    if (new URLSearchParams(window.location.search).has('stats')) {
      setInterval(() => {
        const info = this.renderer.webgl.info;
        console.log(
          `[stats] draws=${info.render.calls} tris=${info.render.triangles} ` +
            `geoms=${info.memory.geometries} tex=${info.memory.textures} fps=${Math.round(this.fpsSmoothed)} ` +
            `lod=[${this.world.debugLodSummary(this.controller.camera.position)}]`,
        );
      }, 2000);
    }

    // Pointer lock flow: click overlay (or canvas) to lock; Esc unlocks.
    this.hud.onStartClick(() => this.lockPointer());
    this.renderer.webgl.domElement.addEventListener('click', () => this.lockPointer());
    document.addEventListener('pointerlockchange', () => {
      if (document.pointerLockElement === this.renderer.webgl.domElement || this.hud.isHackMenuOpen()) {
        this.hud.hideStartOverlay();
      } else {
        this.hud.showStartOverlay();
      }
    });
    document.addEventListener('keydown', (event) => {
      if (event.code === 'KeyR' && !event.repeat) this.shiftAtmosphere();
      if (event.code === 'KeyT' && !event.repeat) this.hud.revealChrome();
      if (event.code === 'Backquote' && !event.repeat) {
        event.preventDefault();
        const open = this.hud.toggleHackMenu();
        if (open && document.pointerLockElement) document.exitPointerLock();
      }
    });
  }

  private lockPointer(): void {
    this.renderer.webgl.domElement.requestPointerLock();
  }

  /**
   * Loading-screen flow. The constructor has already forged the world (terrain,
   * material/foliage atlases, the spawn chunks) and the render loop is running
   * behind the loading screen, so nearby grass/props keep streaming in for a
   * brief warm period. Once the immediate surroundings are populated we switch
   * the loading screen to "Click to enter", which locks the pointer and starts
   * the auto-hiding HUD.
   */
  runIntro(): void {
    const start = performance.now();
    const minMs = GAME.loadingMinMs;
    const maxMs = GAME.loadingMaxMs;
    const tick = (): void => {
      const elapsed = performance.now() - start;
      const ready = elapsed >= maxMs || (elapsed >= minMs && this.world.isNearContentReady());
      if (ready) {
        this.hud.loadingReady(() => {
          this.lockPointer();
          this.hud.revealChrome();
        });
      } else {
        requestAnimationFrame(tick);
      }
    };
    requestAnimationFrame(tick);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.clock.start();
    this.renderer.webgl.setAnimationLoop(() => this.tick());
  }

  private tick(): void {
    // Clamp dt so tab-switch pauses don't catapult the player.
    const dt = Math.min(this.clock.getDelta(), GAME.maxDeltaTime);
    const elapsed = this.clock.elapsedTime;

    this.update(dt, elapsed);
    this.render();
    this.trackPerformance(dt);
  }

  private update(dt: number, elapsed: number): void {
    const cam = this.controller.camera;

    // Physics & movement (colliders gathered from nearby chunks first).
    this.controller.colliders = this.world.getCollidersNear(cam.position);
    this.controller.update(dt);

    const moving =
      this.controller.isKeyDown('KeyW') ||
      this.controller.isKeyDown('KeyA') ||
      this.controller.isKeyDown('KeyS') ||
      this.controller.isKeyDown('KeyD');

    const underwater = cam.position.y < GAME.underwaterThreshold;
    this.world.update(dt, elapsed, cam, this.controller.getWadeDepth(), moving, underwater);
    this.hud.setUnderwater(underwater);
    this.hud.updateDrone(
      this.controller.droneModeActive,
      this.controller.getDroneAltitude(),
      this.controller.getDroneSpeed(),
    );
    this.interaction.update(dt, cam, this.world.getInteractablesNear(cam.position));

    this.statusTimer += dt;
    if (this.statusTimer > GAME.hudStatusInterval) {
      this.statusTimer = 0;
      this.hud.setStatus(
        this.world.environment.timeOfDay,
        this.world.environment.weatherName,
        this.controller.flying,
        this.controller.swimming,
      );
      if (this.hud.isHackMenuOpen()) this.hud.syncHackMenu();
    }
  }

  private render(): void {
    this.renderer.render(this.world.scene, this.controller.camera);
  }

  private shiftAtmosphere(): void {
    this.world.randomizeAtmosphere();
    this.hud.setStatus(
      this.world.environment.timeOfDay,
      this.world.environment.weatherName,
      this.controller.flying,
      this.controller.swimming,
    );
    this.hud.syncHackMenu();
  }

  /** Smoothed FPS readout + automatic pixel-ratio drop on weak hardware. */
  private trackPerformance(dt: number): void {
    const fps = 1 / Math.max(dt, 1e-4);
    this.fpsSmoothed += (fps - this.fpsSmoothed) * GAME.fpsSmoothAlpha;

    this.fpsHudTimer += dt;
    if (this.fpsHudTimer > GAME.fpsHudInterval) {
      this.fpsHudTimer = 0;
      this.hud.setFps(this.fpsSmoothed);
    }

    // Hold off the adaptive drop until nearby content has finished streaming in
    // and ~3s have passed, so a startup spike never permanently lowers the
    // resolution (each change resizes/flashes the framebuffer).
    if (!this.adaptiveArmed) {
      this.adaptiveSettle = this.world.isNearContentReady() ? this.adaptiveSettle + dt : 0;
      if (this.adaptiveSettle > GAME.adaptiveSettleTime) this.adaptiveArmed = true;
      this.lowFpsTime = 0;
      return;
    }

    if (this.fpsSmoothed < RENDERER.adaptiveMinFps) {
      this.lowFpsTime += dt;
      if (
        this.lowFpsTime > RENDERER.adaptiveLowFpsSeconds &&
        this.renderer.getPixelRatioScale() > RENDERER.adaptiveMinPixelRatioScale
      ) {
        this.renderer.setPixelRatioScale(
          this.renderer.getPixelRatioScale() - RENDERER.adaptivePixelRatioStep,
        );
        // Repaint into the freshly resized buffer this same frame so the canvas
        // is never presented blank (which reads as a black flash).
        this.render();
        this.hud.setQuality(`${this.qualityLevel} (reduced res)`);
        this.lowFpsTime = 0;
      }
    } else {
      this.lowFpsTime = 0;
    }
  }
}
