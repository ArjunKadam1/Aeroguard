import * as THREE from "three";
import type { SpeedClass, ThreatProfile } from "../api/types";

const SPEED_UNITS: Record<SpeedClass, number> = { slow: 3, medium: 6, fast: 10 };

// Threats traverse a fixed-width corridor and re-enter from the left instead of
// flying off forever. The camera sits at (0, 30, 60) looking at the origin with a
// 60-degree FOV, which frames roughly -70..+50 on x, so the corridor is centred a
// little left of the origin to match. Duration is derived from the speed class so
// every threat crosses the same spatial path at the cadence its speed implies.
const CORRIDOR_MIN_X = -70;
const CORRIDOR_MAX_X = 50;
const CORRIDOR_WIDTH = CORRIDOR_MAX_X - CORRIDOR_MIN_X;

// Color is derived from the threat id hash only, never from classification_label,
// so the render cannot reveal the ground-truth category the trainee must judge.
const PALETTE = [0x8899aa, 0x99aa88, 0xaa8899, 0x88aabb, 0xbbaa88] as const;

export interface ThreatView {
  profile: ThreatProfile;
  mesh: THREE.Object3D;
}

function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) & 0x7fffffff;
  }
  return hash;
}

export function createThreatView(profile: ThreatProfile): ThreatView {
  const hash = hashString(profile.id);
  const geometry = new THREE.BoxGeometry(2, 1, 2);
  const color = PALETTE[hash % PALETTE.length];
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color }));
  mesh.visible = false;
  mesh.userData.row = ((hash >> 3) % 3) - 1;
  // Phase offset keeps different threats out of lockstep along the corridor.
  mesh.userData.phaseOffset = ((hash >> 5) % 100) / 100;
  return { profile, mesh };
}

export function updateThreatView(view: ThreatView, elapsedSec: number): void {
  const speed = SPEED_UNITS[view.profile.speed_class ?? "medium"];
  const travel = Math.max(0, elapsedSec - view.profile.spawn_time);
  const phaseOffset = view.mesh.userData.phaseOffset as number;
  const row = view.mesh.userData.row as number;
  // Wrap the travelled distance so the threat re-enters from the left each lap
  // rather than exiting the frustum for the rest of the session.
  const lap = (travel * speed + phaseOffset * CORRIDOR_WIDTH) % CORRIDOR_WIDTH;
  view.mesh.position.set(
    CORRIDOR_MIN_X + lap,
    8 + Math.sin(travel) * 0.5,
    row * 20,
  );
  view.mesh.visible = elapsedSec >= view.profile.spawn_time;
}
