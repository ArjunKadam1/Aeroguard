import * as THREE from "three";
import {
  type FlightState,
  type Vec3,
  forwardVector,
  rightVector,
  upVector,
} from "./flight";

export type CameraMode = "fpv" | "chase" | "gimbal";

export const CAMERA_MODES: CameraMode[] = ["fpv", "chase", "gimbal"];

export const CAMERA_LABELS: Record<CameraMode, string> = {
  fpv: "FPV",
  chase: "CHASE",
  gimbal: "GIMBAL",
};

export function nextCameraMode(mode: CameraMode): CameraMode {
  const index = CAMERA_MODES.indexOf(mode);
  return CAMERA_MODES[(index + 1) % CAMERA_MODES.length];
}

// A procedural quadcopter: central body, four arms, motor pods and rotors.
// Built from primitives so there are no external model assets to license.
export function createAircraft(): THREE.Group {
  const group = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x1f2937, roughness: 0.5, metalness: 0.35 });
  const accentMat = new THREE.MeshStandardMaterial({ color: 0x22d3ee, roughness: 0.4, metalness: 0.3 });
  const rotorMat = new THREE.MeshBasicMaterial({ color: 0x9ca3af, transparent: true, opacity: 0.35 });

  const body = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.42, 1.6), bodyMat);
  group.add(body);

  const canopy = new THREE.Mesh(new THREE.SphereGeometry(0.42, 12, 8), accentMat);
  canopy.position.set(0, 0.26, -0.34);
  canopy.scale.set(1, 0.6, 1.1);
  group.add(canopy);

  const arms: Array<[number, number]> = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
  for (const [sx, sz] of arms) {
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.12, 0.95), bodyMat);
    arm.position.set(sx * 0.52, 0, sz * 0.72);
    arm.rotation.y = sx > 0 === sz > 0 ? -0.72 : 0.72;
    group.add(arm);

    const pod = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.2, 0.3, 10), accentMat);
    pod.position.set(sx * 1.05, 0.02, sz * 1.05);
    group.add(pod);

    const rotor = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.62, 0.02, 16), rotorMat);
    rotor.position.set(sx * 1.05, 0.2, sz * 1.05);
    rotor.name = `rotor-${sx}-${sz}`;
    group.add(rotor);
  }
  // A procedural quadcopter: central body, four arms, motor pods and rotors.
  // Built from primitives so there are no external model assets to license.
  group.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.isMesh) {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
    }
  });
  return group;
}

// Spins the rotors; cosmetic only, called each frame.
export function spinRotors(aircraft: THREE.Group, elapsedSec: number): void {
  for (const child of aircraft.children) {
    if (child.name.startsWith("rotor-")) child.rotation.y = elapsedSec * 40;
  }
}

export interface CameraTargets {
  state: FlightState;
  /** Point the gimbal should track, or null to look ahead. */
  focus: THREE.Vector3 | null;
  /** Elapsed seconds, used by the ground-station sweep. */
  elapsedSec: number;
}

// --- Ground station --------------------------------------------------------
// The problem statement describes a trainee who observes an environment and
// identifies objects; it does not describe piloting. The station is therefore
// the default: a FIXED mast that pans on demand, and which can lock onto a
// selected contact. It does not move on its own -- a camera that swings by
// itself hands the trainee the search for them.

/** Fixed mast position. Chosen so the whole contact corridor stays in frame. */
export const STATION_POSITION = { x: 0, y: 50, z: 90 };
/** Default aim point: the middle of the contact lane at cruise altitude. */
export const STATION_AIM = { x: -10, y: 45, z: 0 };
export const STATION_LOCK_OFFSET = { x: 0, y: 6, z: 46 };
export const STATION_MAX_PAN = 0.9;

export interface StationCameraTargets {
  /** Pan offset in radians, driven only by deliberate sweep input. */
  heading: number;
  /** Locked contact position, or null to hold at the station aim. */
  focus: THREE.Vector3 | null;
}

/**
 * Rotate the aim point around the fixed mast by `heading`.
 * Returns the point the camera should look at.
 */
export function stationLookTarget(heading: number): THREE.Vector3 {
  const dx = STATION_AIM.x - STATION_POSITION.x;
  const dz = STATION_AIM.z - STATION_POSITION.z;
  const cos = Math.cos(heading);
  const sin = Math.sin(heading);
  return new THREE.Vector3(
    STATION_POSITION.x + dx * cos - dz * sin,
    STATION_AIM.y,
    STATION_POSITION.z + dx * sin + dz * cos,
  );
}

export function applyStationCamera(
  camera: THREE.PerspectiveCamera,
  targets: StationCameraTargets,
  dt: number,
): void {
  const alpha = dt > 0 ? Math.min(1, dt * 3) : 1;
  const mast = new THREE.Vector3(
    STATION_POSITION.x, STATION_POSITION.y, STATION_POSITION.z,
  );
  if (targets.focus) {
    // Locked on: hold a stable tracking view so detection time is fair.
    const desired = targets.focus.clone().add(
      new THREE.Vector3(
        STATION_LOCK_OFFSET.x, STATION_LOCK_OFFSET.y, STATION_LOCK_OFFSET.z,
      ),
    );
    camera.position.lerp(desired, alpha);
    camera.up.set(0, 1, 0);
    camera.lookAt(targets.focus);
    return;
  }
  // Unlocked: the mast never moves. Only the aim pans, and only because the
  // trainee asked for it. The position is assigned rather than eased because
  // it is fixed and known up front -- easing it would make the camera visibly
  // swing into place when a session starts.
  camera.position.copy(mast);
  camera.up.set(0, 1, 0);
  camera.lookAt(stationLookTarget(targets.heading));
}

export function applyCamera(
  camera: THREE.PerspectiveCamera,
  mode: CameraMode,
  targets: CameraTargets,
  dt: number,
): void {
  const { state, focus } = targets;
  const position = new THREE.Vector3(state.position.x, state.position.y, state.position.z);
  const up = new THREE.Vector3(...upValues(state.attitude));
  const forward = new THREE.Vector3(...forwardValues(state.attitude));
  const right = new THREE.Vector3(...rightValues(state.attitude));

  if (mode === "fpv") {
    // Just behind and above the nose, so the airframe is still partly visible.
    const desired = position.clone()
      .addScaledVector(forward, 0.6)
      .addScaledVector(up, 0.55);
    camera.position.lerp(desired, 1);
    camera.up.copy(up);
    camera.lookAt(position.clone().addScaledVector(forward, 60));
    return;
  }

  if (mode === "chase") {
    const desired = position.clone()
      .addScaledVector(forward, -13)
      .addScaledVector(up, 4.5);
    // Damped follow so the camera lags slightly, which reads as motion.
    const alpha = dt > 0 ? Math.min(1, dt * 4) : 1;
    camera.position.lerp(desired, alpha);
    camera.up.lerp(up, alpha).normalize();
    camera.lookAt(position);
    return;
  }

  // Gimbal: a stabilized sensor head. It looks at the tracked contact, or
  // straight ahead when nothing is selected, and never rolls with the aircraft.
  const desiredLook = focus
    ? focus.clone()
    : position.clone().addScaledVector(forward, 50);
  const desiredPos = position.clone().addScaledVector(forward, 2.2).addScaledVector(up, 1.4);
  const alpha = dt > 0 ? Math.min(1, dt * 6) : 1;
  camera.position.lerp(desiredPos, alpha);
  camera.up.set(0, 1, 0);
  camera.lookAt(desiredLook);
  // Keep roll available so the horizon does not sit weirdly banked.
  right.multiplyScalar(0);
}

function upValues(attitude: Vec3): [number, number, number] {
  const u = upVector(attitude);
  return [u.x, u.y, u.z];
}
function forwardValues(attitude: Vec3): [number, number, number] {
  const f = forwardVector(attitude);
  return [f.x, f.y, f.z];
}
function rightValues(attitude: Vec3): [number, number, number] {
  const r = rightVector(attitude);
  return [r.x, r.y, r.z];
}