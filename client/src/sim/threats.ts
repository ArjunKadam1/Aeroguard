import * as THREE from "three";
import type { PublicThreat, SpeedClass } from "../api/types";

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

export interface ThreatView {
  profile: PublicThreat;
  mesh: THREE.Object3D;
}

function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) & 0x7fffffff;
  }
  return hash;
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
function buildQuad(id: string, color: number): THREE.Group {
  const group = new THREE.Group();
  group.name = `threat-quad-${id}`;
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
  const dot = accentDot(id, color);
  dot.position.set(0, 0.45, 0);
  group.add(dot);
  const lamp = strobe(id);
  lamp.position.set(0, 0.75, 0);
  group.add(lamp);
  const navs = navLights(1.35);
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

export function createThreatView(profile: PublicThreat): ThreatView {
  const hash = hashString(profile.id);
  const color = PALETTE[hash % PALETTE.length];
  const kind = airframeForId(profile.id);
  const mesh = new THREE.Group();
  mesh.add(kind === "quad" ? buildQuad(profile.id, color) : buildWing(profile.id, color));

  mesh.visible = false;
  mesh.userData.airframe = kind;
  mesh.userData.row = ((hash >> 3) % 3) - 1;
  // Phase offset keeps different threats out of lockstep along the corridor,
  // and staggers their strobes so the sky does not blink in unison.
  mesh.userData.phaseOffset = ((hash >> 5) % 100) / 100;
  mesh.userData.strobe = mesh.getObjectByName(`threat-strobe-${profile.id}`);
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
