import * as THREE from 'three';
import { Terrain } from '../world/Terrain';
import { DRONE } from '../config';

type State = 'idle' | 'rising' | 'cruising' | 'landing';

/**
 * Terrain-following autopilot drone. Auto-flies forward, adjusts height for
 * terrain roughness, and supports mouse + arrow-key yaw. States:
 *   rising   – ascend to enterLiftHeight above ground after G pressed
 *   cruising – normal flight, smooth terrain-following P controller
 *   landing  – descend straight down after G pressed again; signals done
 *
 * Height samples use getHeightAt (analytic, no chunk boundaries) so the
 * controller never sees step discontinuities. A low-pass filter on targetY
 * further removes any high-frequency terrain noise before it reaches the
 * camera, keeping the view smooth at all cruise speeds.
 */
export class DroneMode {
  private state: State = 'idle';
  hoverAltitude = DRONE.hoverAltitude;
  private currentSpeed = 0;
  private yaw = 0;
  /** Low-pass filtered target altitude — prevents chunk-boundary steps from
   *  reaching the camera as vertical jerks. */
  private smoothedTargetY = 0;

  constructor(private terrain: Terrain) {}

  get active(): boolean { return this.state !== 'idle'; }

  enter(camera: THREE.PerspectiveCamera): void {
    this.state = 'rising';
    this.yaw = camera.rotation.y;
    // Seed the smoothed target at the current camera height so there is no
    // opening lurch when cruising begins.
    this.smoothedTargetY = camera.position.y;
    const groundY = this.terrain.getHeightAt(camera.position.x, camera.position.z);
    this.hoverAltitude = Math.max(DRONE.enterLiftHeight, camera.position.y - groundY);
  }

  /** Begin the landing sequence instead of hard-cutting. */
  beginLanding(): void {
    if (this.state !== 'idle') this.state = 'landing';
  }

  getCurrentSpeed(): number { return this.currentSpeed; }

  getAltitudeAboveGround(camera: THREE.PerspectiveCamera): number {
    return camera.position.y - this.terrain.getHeightAt(camera.position.x, camera.position.z);
  }

  /**
   * Returns true once landing is complete — caller should deactivate drone mode
   * and return the player to walk mode.
   */
  update(
    dt: number,
    camera: THREE.PerspectiveCamera,
    keys: Set<string>,
    mouseDeltaX: number,
    altitudeDelta: number,
  ): boolean {
    if (this.state === 'idle') return false;
    camera.rotation.order = 'YXZ';
    camera.rotation.z = 0;

    // --- Landing: descend straight down, no steering ---
    if (this.state === 'landing') {
      this.currentSpeed = 0;
      camera.position.y -= DRONE.landingDescentSpeed * dt;
      const groundY = this.terrain.getHeightAt(camera.position.x, camera.position.z);
      camera.rotation.y = this.yaw;
      camera.rotation.x = 0;
      if (camera.position.y <= groundY + DRONE.landingCompleteHeight) {
        camera.position.y = groundY + DRONE.landingCompleteHeight;
        this.state = 'idle';
        return true;
      }
      return false;
    }

    // --- Yaw: mouse + arrow keys ---
    this.yaw -= mouseDeltaX * DRONE.yawSensitivity * 0.001;
    if (keys.has('ArrowLeft'))  this.yaw += DRONE.keyYawSpeed * dt;
    if (keys.has('ArrowRight')) this.yaw -= DRONE.keyYawSpeed * dt;

    // --- Rising: ascend to hover altitude before cruising ---
    if (this.state === 'rising') {
      this.currentSpeed = 0;
      const groundY = this.terrain.getHeightAt(camera.position.x, camera.position.z);
      const targetY = groundY + this.hoverAltitude;
      camera.position.y += (targetY - camera.position.y) * Math.min(1, dt * 2.5);
      this.smoothedTargetY = camera.position.y;
      camera.rotation.y = this.yaw;
      camera.rotation.x = 0;
      if (Math.abs(camera.position.y - targetY) < 0.8) this.state = 'cruising';
      return false;
    }

    // --- Cruising ---
    this.hoverAltitude = Math.max(3, this.hoverAltitude + altitudeDelta * dt);

    const sprinting = keys.has('ShiftLeft') || keys.has('ShiftRight');
    const speed = sprinting ? DRONE.sprintSpeed : DRONE.cruiseSpeed;
    this.currentSpeed = speed;

    // Target a fixed altitude above the ground directly below — cinematic
    // constant-height feel. The low-pass filter handles gradual terrain changes
    // smoothly; steep sudden rises are caught by the hard floor below.
    // Target a fixed altitude above the ground directly below — cinematic
    // constant-height feel. The low-pass filter handles gradual terrain changes
    // smoothly; steep sudden rises are caught by the hard floor below.
    const groundBelow = this.terrain.getHeightAt(camera.position.x, camera.position.z);
    const rawTargetY = groundBelow + this.hoverAltitude;

    // Low-pass filter so the camera doesn't react to every small terrain ripple.
    this.smoothedTargetY += (rawTargetY - this.smoothedTargetY) * Math.min(1, dt * DRONE.heightSmoothRate);

    const error = this.smoothedTargetY - camera.position.y;
    const vertVel = Math.max(-DRONE.vertVelMax, Math.min(DRONE.vertVelMax, error * DRONE.heightPGain));

    camera.position.x -= Math.sin(this.yaw) * speed * dt;
    camera.position.z -= Math.cos(this.yaw) * speed * dt;
    camera.position.y += vertVel * dt;

    // Hard floor prevents clipping on sudden steep rises.
    if (camera.position.y < groundBelow + 2.0) camera.position.y = groundBelow + 2.0;

    // Pitch gently toward horizon — small downward tilt for cinematic feel.
    const pitchTarget = -0.06;
    camera.rotation.y = this.yaw;
    camera.rotation.x += (pitchTarget - camera.rotation.x) * Math.min(1, dt * DRONE.pitchSmoothRate);

    return false;
  }
}
