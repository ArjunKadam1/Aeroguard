import * as THREE from "three";
import type { PublicThreat, SpeedClass } from "../api/types";
import {
  AIRSPACE_X,
  AIRSPACE_Z,
  ALT_OFFSET_MAX,
  ALT_OFFSET_MIN,
  corridorParams,
  hashString,
  resolvePattern,
  trajectoryPosition,
} from "./trajectory";
import { flownPoint } from "./kinematics";
import { ESCORT_COUNT, escortOffsets, swarmOffsetAt } from "./formation";
import type { SwarmContext } from "./swarm";

const SPEED_UNITS: Record<SpeedClass, number> = { slow: 3, medium: 6, fast: 10 };

// Visibility design: a threat must be readable against BOTH a bright day sky
// and a dark night sky. Any single color fails one of them (a mid-tone against
// the pale day sky measures ~1.1:1). So each threat is drawn as a dark
// silhouette with a self-lit id-hash accent dot that ignores fog, plus
// aviation-style lights. Visibility comes from the bright-on-dark contrast,
// which holds against any background.
//
// Airframe shape is derived from the threat id hash only, never from any
// hidden classification -- and the profile here is a PublicThreat, which
// carries no classification at all, so the render cannot reveal the category
// the trainee must judge.
const PALETTE = [0xff6b35, 0x22d3ee, 0x84cc16, 0xd946ef, 0xf59e0b] as const;

// Shared unlit materials: one program, no per-frame cost, readable day and
// night because they ignore fog and lighting.
const bodyMat = new THREE.MeshBasicMaterial({ color: 0x10151b, fog: false });
const rotorMat = new THREE.MeshBasicMaterial({
  color: 0x9aa4ad, transparent: true, opacity: 0.45, fog: false,
});
const strobeMat = new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false });
const navRedMat = new THREE.MeshBasicMaterial({ color: 0xff2d2d, fog: false });
const navGreenMat = new THREE.MeshBasicMaterial({ color: 0x2dff5e, fog: false });

export type AirframeKind = "quad" | "wing";

/** Airframe from the id hash only: shape can never leak classification. */
export function airframeForId(id: string): AirframeKind {
  return hashString(id) % 2 === 0 ? "quad" : "wing";
}

/**
 * Swarm-capable contact: a subset of quad airframes presents as a tight
 * three-drone formation (see sim/formation.ts). Derived from the id hash only,
 * never from the hidden classification -- like the airframe art, the render
 * cannot reveal what the trainee must judge.
 */
export function isSwarmContact(id: string): boolean {
  return airframeForId(id) === "quad" && hashString(`swarm|${id}`) % 4 === 0;
}

export interface ThreatView {
  profile: PublicThreat;
  mesh: THREE.Object3D;
}

function accentDot(id: string, color: number): THREE.Mesh {
  // Id-hash color chip so contacts stay distinguishable from each other.
  const dot = new THREE.Mesh(
    new THREE.BoxGeometry(0.5, 0.5, 0.5),
    new THREE.MeshBasicMaterial({ color, fog: false }),
  );
  dot.name = `threat-core-${id}`;
  return dot;
}

function strobe(id: string): THREE.Mesh {
  const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.22, 8, 6), strobeMat);
  lamp.name = `threat-strobe-${id}`;
  return lamp;
}

function navLights(span: number): THREE.Group {
  // Port red / starboard green relative to the +x direction of travel:
  // right = forward × up = +z, so green sits at +z and red at -z.
  const group = new THREE.Group();
  const red = new THREE.Mesh(new THREE.SphereGeometry(0.16, 8, 6), navRedMat);
  red.position.set(0, 0, -span);
  const green = new THREE.Mesh(new THREE.SphereGeometry(0.16, 8, 6), navGreenMat);
  green.position.set(0, 0, span);
  group.add(red, green);
  return group;
}

// Quadcopter facing +x: central body, cross arms, four rotor discs.
// With `escortIndex` set it builds a scaled-down wingman: no accent dot and no
// strobe -- only the lead airframe carries the contact's identity lights.
function buildQuad(id: string, color: number, escortIndex?: number): THREE.Group {
  const escort = escortIndex !== undefined;
  const group = new THREE.Group();
  group.name = escort ? `threat-escort-${id}-${escortIndex}` : `threat-quad-${id}`;
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.4, 1.2), bodyMat);
  group.add(body);
  const armX = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.12, 0.18), bodyMat);
  const armZ = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.12, 2.6), bodyMat);
  group.add(armX, armZ);
  const rotorGeo = new THREE.CylinderGeometry(0.45, 0.45, 0.04, 10);
  for (const [mx, mz] of [[1.2, 0], [-1.2, 0], [0, 1.2], [0, -1.2]] as const) {
    const rotor = new THREE.Mesh(rotorGeo, rotorMat);
    rotor.position.set(mx, 0.12, mz);
    group.add(rotor);
  }
  if (!escort) {
    const dot = accentDot(id, color);
    dot.position.set(0, 0.45, 0);
    group.add(dot);
    const lamp = strobe(id);
    lamp.position.set(0, 0.75, 0);
    group.add(lamp);
  }
  const navs = navLights(escort ? 0.9 : 1.35);
  group.add(navs);
  return group;
}

// Fixed-wing facing +x: fuselage, main wing, tailplane and fin.
function buildWing(id: string, color: number): THREE.Group {
  const group = new THREE.Group();
  group.name = `threat-wing-${id}`;
  const fuselageGeo = new THREE.CylinderGeometry(0.28, 0.2, 2.8, 8);
  fuselageGeo.rotateZ(Math.PI / 2);
  group.add(new THREE.Mesh(fuselageGeo, bodyMat));
  const wing = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.1, 4.4), bodyMat);
  wing.position.set(0.2, 0, 0);
  group.add(wing);
  const tail = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.08, 1.8), bodyMat);
  tail.position.set(-1.3, 0.05, 0);
  group.add(tail);
  const fin = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.8, 0.08), bodyMat);
  fin.position.set(-1.3, 0.4, 0);
  group.add(fin);
  const dot = accentDot(id, color);
  dot.position.set(0, 0.45, 0);
  group.add(dot);
  const lamp = strobe(id);
  lamp.position.set(-1.55, 0.1, 0);
  group.add(lamp);
  const navs = navLights(2.2);
  navs.position.set(0.2, 0, 0);
  group.add(navs);
  return group;
}

export function createThreatView(
  profile: PublicThreat,
  seed: number,
  group?: SwarmContext,
): ThreatView {
  const hash = hashString(profile.id);
  const color = PALETTE[hash % PALETTE.length];
  const kind = airframeForId(profile.id);
  const mesh = new THREE.Group();
  mesh.add(kind === "quad" ? buildQuad(profile.id, color) : buildWing(profile.id, color));

  // Swarm presentation: agile swarm-capable quads fly as a tight trio. A
  // contact that is a member of a real, separately scored swarm gets none of
  // these decorative escorts -- its wingmen are contacts of their own. The
  // corridor keeps its legacy single-airframe art. Escorts are visual-only:
  // the contact stays one echo for the sensor, the HUD, and the scoring, and
  // a tight formation really is one radar resolution cell.
  const escorts: THREE.Object3D[] = [];
  if (
    !group
    && kind === "quad"
    && isSwarmContact(profile.id)
    && resolvePattern(profile.flight_pattern) !== "straight-transit"
  ) {
    const start = escortOffsets(seed, profile.id, 0);
    for (let i = 0; i < ESCORT_COUNT; i += 1) {
      const escort = buildQuad(profile.id, color, i);
      escort.scale.setScalar(0.62);
      escort.position.set(start[i].x, start[i].y, start[i].z);
      escorts.push(escort);
      mesh.add(escort);
    }
  }

  mesh.visible = false;
  mesh.userData.airframe = kind;
  mesh.userData.escorts = escorts;
  mesh.userData.group = group;
  // Corridor stagger (id-hashed, unchanged); the scenario seed rides along for
  // T1's seeded parameter derivation.
  const params = corridorParams(profile.id);
  mesh.userData.row = params.row;
  // Phase offset keeps different threats out of lockstep along the corridor,
  // and staggers their strobes so the sky does not blink in unison.
  mesh.userData.phaseOffset = params.phase;
  mesh.userData.seed = seed;
  mesh.userData.strobe = mesh.getObjectByName(`threat-strobe-${profile.id}`);
  return { profile, mesh };
}

export interface ContactPlan {
  x: number;
  z: number;
  altOffset: number;
  visible: boolean;
  /** Direction of travel, radians (atan2(dz, dx)); 0 for the corridor. */
  headingRad: number;
}

/** Pure plan position: where the contact actually flies. No terrain. */
export function planContact(
  profile: PublicThreat,
  seed: number,
  elapsedSec: number,
  group?: SwarmContext,
): ContactPlan {
  // A swarm wingman rides the lead's flown plan. Its slot is expressed in the
  // lead's local frame and rotated onto the lead's actual heading; the seeded
  // wander keeps the formation alive without touching the lead's own path.
  if (group && group.index > 0 && group.lead.id !== profile.id) {
    const leadPlan = planContact(group.lead, seed, elapsedSec);
    const travel = Math.max(0, elapsedSec - group.lead.spawn_time);
    const offset = swarmOffsetAt(seed, profile.id, group.index, travel);
    const cos = Math.cos(leadPlan.headingRad);
    const sin = Math.sin(leadPlan.headingRad);
    return {
      // Clamp to the same airspace box the flown path uses. Near an edge the
      // formation compresses instead of leaving the world, which is both a
      // rendering invariant and what a real group would do.
      x: Math.min(
        AIRSPACE_X,
        Math.max(-AIRSPACE_X, leadPlan.x + offset.x * cos - offset.z * sin),
      ),
      z: Math.min(
        AIRSPACE_Z,
        Math.max(-AIRSPACE_Z, leadPlan.z + offset.x * sin + offset.z * cos),
      ),
      altOffset: Math.min(
        ALT_OFFSET_MAX,
        Math.max(ALT_OFFSET_MIN, leadPlan.altOffset + offset.y),
      ),
      visible: leadPlan.visible,
      headingRad: leadPlan.headingRad,
    };
  }
  const speed = SPEED_UNITS[profile.speed_class ?? "medium"];
  const travel = Math.max(0, elapsedSec - profile.spawn_time);
  const visible = elapsedSec >= profile.spawn_time;
  const pattern = resolvePattern(profile.flight_pattern);
  if (pattern === "straight-transit") {
    // Corridor: legacy closed-form path with its lap-wrap semantics.
    const point = trajectoryPosition(pattern, travel, speed, seed, profile.id);
    return { x: point.x, z: point.z, altOffset: point.altOffset, visible, headingRad: 0 };
  }
  // Agile patterns are flown through the airframe model, so a wing and a quad
  // trace visibly different paths (see sim/kinematics.ts).
  const flown = flownPoint(pattern, airframeForId(profile.id), speed, seed, profile.id, travel);
  return {
    x: flown.x,
    z: flown.z,
    altOffset: flown.altOffset,
    visible,
    headingRad: flown.headingRad,
  };
}

/**
 * Full world position, using the exact composition the session loop applies:
 * terrain-following cruise floor plus the clamped trajectory offset plus the
 * ambient bob. The replay uses this to reproduce flown paths bit-identically.
 */
export function threatPositionAt(
  profile: PublicThreat,
  seed: number,
  elapsedSec: number,
  groundAt: (x: number, z: number) => number,
  group?: SwarmContext,
): { x: number; y: number; z: number; visible: boolean } {
  const plan = planContact(profile, seed, elapsedSec, group);
  const climb = Math.min(45, Math.max(-20, plan.altOffset));
  return {
    x: plan.x,
    z: plan.z,
    y: groundAt(plan.x, plan.z) + THREAT_CRUISE_ALTITUDE + climb + Math.sin(elapsedSec) * 2,
    visible: plan.visible,
  };
}

export function updateThreatView(view: ThreatView, elapsedSec: number): void {
  const travel = Math.max(0, elapsedSec - view.profile.spawn_time);
  // Assigned pattern executes here; the scenario seed joins the parameter
  // derivation so identical ids diverge across seeds.
  const seed = (view.mesh.userData.seed as number | undefined) ?? 0;
  const group = view.mesh.userData.group as SwarmContext | undefined;
  const plan = planContact(view.profile, seed, elapsedSec, group);
  view.mesh.userData.altOffset = plan.altOffset;
  view.mesh.position.set(
    plan.x,
    8 + Math.sin(travel) * 0.5 + plan.altOffset,
    plan.z,
  );
  view.mesh.visible = plan.visible;
  // Yaw the +x-facing airframe onto its actual direction of travel. The
  // corridor flies +x by construction (heading 0), so its legacy visuals stay
  // byte-identical; agile patterns now face their turns instead of flying
  // sideways. (`=== 0` normalizes the sign so the corridor stays exactly +0.)
  view.mesh.rotation.y = plan.headingRad === 0 ? 0 : -plan.headingRad;
  // Swarm escorts: wingmen wander around their slots in the lead's local
  // frame, so they inherit its position and yaw as children. Purely visual;
  // the plan position and the sensor truth stay with the lead.
  const escorts = view.mesh.userData.escorts as THREE.Object3D[] | undefined;
  if (escorts && escorts.length > 0) {
    const offsets = escortOffsets(seed, view.profile.id, travel);
    for (let i = 0; i < escorts.length; i += 1) {
      escorts[i].position.set(offsets[i].x, offsets[i].y, offsets[i].z);
    }
  }
  // Aviation-style white strobe: brief flash roughly once a second, staggered
  // per contact so threats do not blink in unison.
  const strobe = view.mesh.userData.strobe as THREE.Object3D | undefined;
  if (strobe) {
    const phase = view.mesh.userData.phaseOffset as number;
    strobe.visible = ((elapsedSec * 1.1 + phase) % 1) < 0.12;
  }
}

// Threat altitude above local terrain, so contacts cruise over hills rather
// than through them once the world has real elevation.
export const THREAT_CRUISE_ALTITUDE = 45;
