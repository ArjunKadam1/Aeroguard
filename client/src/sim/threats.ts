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

// Visibility design: a threat must be readable against BOTH a bright day sky
// and a dark night sky. Any single color fails one of them (a mid-tone against
// the pale day sky measures ~1.1:1). So each threat is drawn as a self-lit core
// that ignores fog, wrapped in a dark outline shell. Visibility comes from the
// bright-on-dark silhouette, which holds against any background.
//
// Color is derived from the threat id hash only, never from classification_label,
// so the render cannot reveal the ground-truth category the trainee must judge.
const PALETTE = [0xff6b35, 0x22d3ee, 0x84cc16, 0xd946ef, 0xf59e0b] as const;

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
  const color = PALETTE[hash % PALETTE.length];
  const mesh = new THREE.Group();

  // Dark outline shell, slightly larger so it reads as a rim around the core.
  const shellGeometry = new THREE.BoxGeometry(3.0, 2.0, 3.0);
  const shell = new THREE.Mesh(
    shellGeometry,
    new THREE.MeshBasicMaterial({ color: 0x0b0f14, fog: false }),
  );
  // Self-lit core so it never washes out against the sky or gets fogged away.
  const coreGeometry = new THREE.BoxGeometry(2.0, 1.0, 2.0);
  const core = new THREE.Mesh(
    coreGeometry,
    new THREE.MeshBasicMaterial({ color, fog: false }),
  );
  core.name = `threat-core-${profile.id}`;
  mesh.add(shell, core);

  mesh.visible = false;
  mesh.userData.row = ((hash >> 3) % 3) - 1;
  // Phase offset keeps different threats out of lockstep along the corridor.
  mesh.userData.phaseOffset = ((hash >> 5) % 100) / 100;
  mesh.userData.core = core;
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

// Threat altitude above local terrain, so contacts cruise over hills rather
// than through them once the world has real elevation.
export const THREAT_CRUISE_ALTITUDE = 45;
