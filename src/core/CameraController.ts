import * as THREE from 'three';
import { CAMERA, DRONE, PLAYER, WORLD } from '../config';
import { clamp, damp } from '../utils/MathUtils';
import type { Terrain } from '../world/Terrain';
import { DroneMode } from './DroneMode';

export interface CylinderCollider {
  x: number;
  z: number;
  radius: number;
}

/**
 * First-person controller: pointer-lock mouse look, WASD with smooth
 * acceleration, sprint, jump, gravity, slope-aware speed, collision against
 * the rendered terrain surface and cylinder push-out for trunks/boulders.
 *
 * Fly mode (toggle F): free movement — WASD horizontal, Space up, Z down,
 * Shift for speed. Toggling off hands you back to gravity mid-air.
 */
export class CameraController {
  readonly camera: THREE.PerspectiveCamera;

  flying = false;
  swimming = false;

  private droneMode: DroneMode;
  droneModeActive = false;
  private accumulatedMouseX = 0;
  private accumulatedAltitudeDelta = 0;

  private velocity = new THREE.Vector3();
  private yaw = 0;
  private pitch = 0;
  private grounded = false;
  private keys = new Set<string>();
  private pointerLocked = false;

  /** Filled each frame by the chunk manager with nearby solid obstacles. */
  colliders: CylinderCollider[] = [];

  /** Set by Game after construction; enables underground floor/ceiling collision. */
  caveNetwork: import('../world/Caves').CaveNetwork | null = null;

  // Scratch objects (avoid per-frame allocation).
  private wishDir = new THREE.Vector3();
  private forward = new THREE.Vector3();
  private right = new THREE.Vector3();
  private normal = new THREE.Vector3();

  constructor(private terrain: Terrain, domElement: HTMLElement) {
    this.droneMode = new DroneMode(terrain);
    this.camera = new THREE.PerspectiveCamera(
      CAMERA.fieldOfView,
      window.innerWidth / window.innerHeight,
      CAMERA.nearClip,
      CAMERA.farClip,
    );
    this.camera.rotation.order = 'YXZ';
    if (new URLSearchParams(window.location.search).has('looksky')) {
      this.pitch = Math.PI * 0.42;
    }

    document.addEventListener('keydown', (e) => {
      this.keys.add(e.code);
      if (e.code === 'Space') e.preventDefault();
      if (
        e.code === 'ArrowLeft' ||
        e.code === 'ArrowRight' ||
        e.code === 'ArrowUp' ||
        e.code === 'ArrowDown'
      ) {
        e.preventDefault();
      }
      if (e.code === 'KeyF' && this.pointerLocked) {
        this.flying = !this.flying;
        if (this.flying) this.velocity.y = 0;
      }
      if (e.code === 'KeyG' && this.pointerLocked) {
        if (this.droneModeActive) {
          this.droneMode.beginLanding();
        } else {
          this.droneMode.enter(this.camera);
          this.droneModeActive = true;
          this.flying = false;
          this.swimming = false;
        }
      }
    });
    document.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());

    document.addEventListener('mousemove', (e) => {
      if (!this.pointerLocked) return;
      if (this.droneModeActive) {
        this.accumulatedMouseX += e.movementX;
      } else {
        this.yaw -= e.movementX * PLAYER.mouseSensitivity;
        this.pitch -= e.movementY * PLAYER.mouseSensitivity;
        this.pitch = clamp(this.pitch, -Math.PI / 2 + 0.01, Math.PI / 2 - 0.01);
      }
    });

    domElement.addEventListener('wheel', (e) => {
      if (this.droneModeActive) {
        this.accumulatedAltitudeDelta -= e.deltaY * DRONE.wheelAltitudeScale;
      }
    });

    document.addEventListener('pointerlockchange', () => {
      this.pointerLocked = document.pointerLockElement === domElement;
    });
  }

  /** Place the player on the ground at a world position. */
  spawnAt(x: number, z: number): void {
    const y = this.terrain.getMeshHeightAt(x, z) + PLAYER.eyeHeight;
    this.camera.position.set(x, y, z);
    this.velocity.set(0, 0, 0);
    this.flying = false;
    this.swimming = false;
    this.grounded = false;
  }

  isPointerLocked(): boolean {
    return this.pointerLocked;
  }

  isKeyDown(code: string): boolean {
    return this.keys.has(code);
  }

  /** Depth of the player's feet below the water surface (0 when dry). */
  getWadeDepth(): number {
    const feetY = this.camera.position.y - PLAYER.eyeHeight;
    return Math.max(0, 0 - feetY); // water level is 0
  }

  getDroneAltitude(): number {
    return this.droneModeActive ? this.droneMode.getAltitudeAboveGround(this.camera) : 0;
  }

  getDroneSpeed(): number {
    return this.droneModeActive ? this.droneMode.getCurrentSpeed() : 0;
  }

  update(dt: number): void {
    if (this.droneModeActive) {
      if (this.keys.has('KeyQ') || this.keys.has('ArrowUp'))   this.accumulatedAltitudeDelta += DRONE.altitudeChangeRate * dt;
      if (this.keys.has('KeyE') || this.keys.has('ArrowDown')) this.accumulatedAltitudeDelta -= DRONE.altitudeChangeRate * dt;
      const done = this.droneMode.update(dt, this.camera, this.keys, this.accumulatedMouseX, this.accumulatedAltitudeDelta);
      this.accumulatedMouseX = 0;
      this.accumulatedAltitudeDelta = 0;
      if (done) {
        this.droneModeActive = false;
        this.flying = false;
        this.velocity.set(0, 0, 0);
        this.grounded = false;
      }
      return;
    }

    const cam = this.camera;
    cam.rotation.set(this.pitch, this.yaw, 0);

    if (this.flying) {
      this.swimming = false;
      this.updateFlying(dt);
      return;
    }

    if (this.getWadeDepth() > PLAYER.eyeHeight * PLAYER.swimWadeThreshold) {
      this.updateSwimming(dt);
      return;
    }
    this.swimming = false;

    // Movement basis on the horizontal plane.
    this.forward.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    this.right.set(-this.forward.z, 0, this.forward.x);

    this.wishDir.set(0, 0, 0);
    if (this.pointerLocked) {
      if (this.keys.has('KeyW')) this.wishDir.add(this.forward);
      if (this.keys.has('KeyS')) this.wishDir.sub(this.forward);
      if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) this.wishDir.add(this.right);
      if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) this.wishDir.sub(this.right);
    }
    const moving = this.wishDir.lengthSq() > 0;
    if (moving) this.wishDir.normalize();

    const sprinting = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
    let targetSpeed = sprinting ? PLAYER.sprintSpeed : PLAYER.walkSpeed;

    // Wading slows you down.
    const wade = this.getWadeDepth();
    if (wade > PLAYER.wadeSlowThreshold) targetSpeed *= clamp(1 - wade * PLAYER.wadeSpeedReduction, 0.35, 1);

    // Slope-aware speed: climbing steep ground is slower; very steep ground
    // also makes you slide.
    this.terrain.getNormalAt(cam.position.x, cam.position.z, this.normal);
    const slopeFlatness = this.normal.y; // 1 = flat, 0 = vertical
    if (moving && this.grounded) {
      const uphill = -(this.wishDir.x * this.normal.x + this.wishDir.z * this.normal.z);
      if (uphill > 0) {
        targetSpeed *= clamp(1 - uphill * (1 - slopeFlatness) * PLAYER.slopeSpeedPenalty, 0.3, 1);
      }
    }

    // Smooth horizontal acceleration / deceleration.
    const accel = this.grounded ? PLAYER.acceleration : PLAYER.acceleration * PLAYER.airControl;
    this.velocity.x = damp(this.velocity.x, this.wishDir.x * targetSpeed, accel, dt);
    this.velocity.z = damp(this.velocity.z, this.wishDir.z * targetSpeed, accel, dt);

    // Slide down very steep slopes.
    if (this.grounded && slopeFlatness < PLAYER.slideThreshold) {
      const slide = (PLAYER.slideThreshold - slopeFlatness) * PLAYER.slideAcceleration * dt;
      this.velocity.x += this.normal.x * slide;
      this.velocity.z += this.normal.z * slide;
    }

    // Gravity and jumping.
    this.velocity.y -= PLAYER.gravity * dt;
    if (this.grounded && this.pointerLocked && this.keys.has('Space')) {
      this.velocity.y = PLAYER.jumpSpeed;
      this.grounded = false;
    }

    cam.position.addScaledVector(this.velocity, dt);
    this.resolveColliders();

    // Terrain collision against the rendered surface: never fall through.
    const caveCtx = this.caveNetwork?.getCaveContext(cam.position.x, cam.position.y, cam.position.z) ?? null;
    const groundY = this.terrain.getMeshHeightAt(cam.position.x, cam.position.z);
    const minY = caveCtx ? caveCtx.floor + PLAYER.eyeHeight : groundY + PLAYER.eyeHeight;
    if (caveCtx) {
      cam.position.y = Math.min(cam.position.y, caveCtx.ceiling - 0.3);
    }
    if (cam.position.y <= minY) {
      cam.position.y = minY;
      this.velocity.y = 0;
      this.grounded = true;
    } else {
      // Small tolerance keeps "grounded" stable walking downhill.
      this.grounded = cam.position.y - minY < PLAYER.groundedTolerance;
    }
  }

  private updateFlying(dt: number): void {
    const cam = this.camera;
    // Fly along the view direction (full 3D forward).
    cam.getWorldDirection(this.forward);
    this.right.set(-this.forward.z, 0, this.forward.x).normalize();

    this.wishDir.set(0, 0, 0);
    if (this.pointerLocked) {
      if (this.keys.has('KeyW')) this.wishDir.add(this.forward);
      if (this.keys.has('KeyS')) this.wishDir.sub(this.forward);
      if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) this.wishDir.add(this.right);
      if (this.keys.has('KeyA') || this.keys.has('ArrowLeft'))  this.wishDir.sub(this.right);
      if (this.keys.has('Space') || this.keys.has('ArrowUp'))   this.wishDir.y += 1;
      if (this.keys.has('KeyZ')  || this.keys.has('ArrowDown')) this.wishDir.y -= 1;
    }
    if (this.wishDir.lengthSq() > 0) this.wishDir.normalize();

    const sprinting = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
    const speed = sprinting ? PLAYER.flySprintSpeed : PLAYER.flySpeed;

    this.velocity.x = damp(this.velocity.x, this.wishDir.x * speed, PLAYER.flyDampCoeff, dt);
    this.velocity.y = damp(this.velocity.y, this.wishDir.y * speed, PLAYER.flyDampCoeff, dt);
    this.velocity.z = damp(this.velocity.z, this.wishDir.z * speed, PLAYER.flyDampCoeff, dt);

    cam.position.addScaledVector(this.velocity, dt);

    // Don't fly through the ground.
    const minY = this.terrain.getMeshHeightAt(cam.position.x, cam.position.z) + PLAYER.flyMinGroundClearance;
    if (cam.position.y < minY) cam.position.y = minY;
    this.grounded = false;
  }

  private updateSwimming(dt: number): void {
    const cam = this.camera;
    this.swimming = true;
    cam.getWorldDirection(this.forward);
    this.right.set(-this.forward.z, 0, this.forward.x).normalize();

    this.wishDir.set(0, 0, 0);
    if (this.pointerLocked) {
      if (this.keys.has('KeyW')) this.wishDir.add(this.forward);
      if (this.keys.has('KeyS')) this.wishDir.sub(this.forward);
      if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) this.wishDir.add(this.right);
      if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) this.wishDir.sub(this.right);
      if (this.keys.has('Space')) this.wishDir.y += 1;
      if (this.keys.has('KeyZ')) this.wishDir.y -= 1;
    }
    if (this.wishDir.lengthSq() > 0) this.wishDir.normalize();

    const sprinting = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
    const speed = sprinting ? PLAYER.swimSprintSpeed : PLAYER.swimSpeed;
    this.velocity.x = damp(this.velocity.x, this.wishDir.x * speed, PLAYER.swimDampH, dt);
    this.velocity.y = damp(this.velocity.y, this.wishDir.y * speed, PLAYER.swimDampV, dt);
    this.velocity.z = damp(this.velocity.z, this.wishDir.z * speed, PLAYER.swimDampH, dt);

    cam.position.addScaledVector(this.velocity, dt);
    this.resolveColliders();

    // Swimming can reach the surface but never becomes water-powered flight.
    // Keep the eyes above the waterline at the surface so the horizon remains
    // visible instead of slicing through the center of the view.
    const surfaceY = WORLD.waterLevel + PLAYER.swimSurfaceOffset;
    if (cam.position.y > surfaceY) {
      cam.position.y = surfaceY;
      this.velocity.y = Math.min(0, this.velocity.y);
    }
    const bottomY = this.terrain.getMeshHeightAt(cam.position.x, cam.position.z) + PLAYER.swimFloorClearance;
    if (cam.position.y < bottomY) {
      cam.position.y = bottomY;
      this.velocity.y = Math.max(0, this.velocity.y);
    }
    this.grounded = false;
  }

  private resolveColliders(): void {
    const cam = this.camera;
    for (const c of this.colliders) {
      const dx = cam.position.x - c.x;
      const dz = cam.position.z - c.z;
      const minDist = c.radius + PLAYER.collisionRadius;
      const distSq = dx * dx + dz * dz;
      if (distSq < minDist * minDist && distSq > 1e-6) {
        const dist = Math.sqrt(distSq);
        const push = (minDist - dist) / dist;
        cam.position.x += dx * push;
        cam.position.z += dz * push;
      }
    }
  }
}
