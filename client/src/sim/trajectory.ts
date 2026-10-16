// Trajectory execution for assigned flight patterns (T1 pattern library).
// Pure math, no Three.js, no terrain: unit-testable in the node environment.
//
// Contract: every pattern is a closed-form continuous function of travel
// time, deterministic in (seed, id), bounded inside the wide airspace box
// (|x| <= 550, |z| <= 360, altOffset in [-20, 30]), and independent of the
// hidden classification label. Terrain clearance is NOT handled here --
// main.ts composes altOffset over the terrain-following cruise floor.

import type { FlightPattern } from "../api/types";

// Today's corridor, preserved verbatim as the straight-transit path and the
// fallback for unknown patterns: threats traverse a fixed-width band and
// re-enter from the left each lap.
export const CORRIDOR_MIN_X = -70;
export const CORRIDOR_MAX_X = 50;
export const CORRIDOR_WIDTH = CORRIDOR_MAX_X - CORRIDOR_MIN_X;

// Wide airspace box for the T1 patterns. Everything stays inside the 1200u
// station visual range (findable) while routinely leaving the ±29° mast wedge
// (sweeping matters).
export const AIRSPACE_X = 550;
export const AIRSPACE_Z = 360;
export const ALT_OFFSET_MIN = -20;
export const ALT_OFFSET_MAX = 30;

export const KNOWN_PATTERNS: readonly FlightPattern[] = [
  "straight-transit",
  "wide-weave",
  "erratic-jink",
  "orbit-hold",
  "direct-approach",
  "altitude-step",
  "perimeter-sweep",
];

/** Unknown or absent patterns fall back to straight transit, never to nothing. */
export function resolvePattern(pattern: FlightPattern | string | null | undefined): FlightPattern {
  return (KNOWN_PATTERNS as readonly string[]).includes(pattern ?? "")
    ? (pattern as FlightPattern)
    : "straight-transit";
}

export function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) & 0x7fffffff;
  }
  return hash;
}

/** Deterministic 0..1 stream from integer arithmetic (exact in doubles). */
function mulberry32(state: number): () => number {
  let a = state >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, values: readonly T[]): T {
  return values[Math.floor(rng() * values.length)];
}

export interface TrajectoryParams {
  phase: number;
  dir: 1 | -1;
  lane: number;
  lane2: number;
  amp: number;
  amp2: number;
  cyc: number;
  w1: number;
  wratio: number;
  walt: number;
  p1: number;
  p2: number;
  p3: number;
  alt: number;
  a1: number;
  a2: number;
  rx: number;
  rz: number;
  t1: number;
  dt: number;
  dur: number;
  w8: number;
  ax: number;
  az: number;
}

/** Discrete parameter draw per (seed, id, pattern): stable, bounded, labeled. */
export function deriveParams(seed: number, id: string, pattern: FlightPattern): TrajectoryParams {
  const rng = mulberry32(hashString(`${seed}:${id}:${pattern}`));
  const twoPi = Math.PI * 2;
  return {
    phase: rng(),
    dir: rng() < 0.5 ? 1 : -1,
    lane: pick(rng, [-300, -150, 0, 150, 300] as const),
    lane2: pick(rng, [-200, 0, 200] as const),
    amp: pick(rng, [80, 120, 150] as const),
    amp2: pick(rng, [10, 20, 30] as const),
    cyc: pick(rng, [1, 1.5, 2] as const),
    w1: pick(rng, [0.12, 0.18, 0.24] as const),
    wratio: pick(rng, [2.3, 2.7, 3.1] as const),
    walt: pick(rng, [0.8, 1.1] as const),
    p1: rng() * twoPi,
    p2: rng() * twoPi,
    p3: rng() * twoPi,
    alt: pick(rng, [-10, 0, 10, 20] as const),
    a1: pick(rng, [20, 30] as const),
    a2: pick(rng, [-20, 20, 30] as const),
    rx: pick(rng, [100, 150, 200] as const),
    rz: pick(rng, [80, 120, 160] as const),
    t1: pick(rng, [10, 20, 30] as const),
    dt: pick(rng, [25, 35, 45] as const),
    dur: pick(rng, [6, 8, 10] as const),
    w8: pick(rng, [0.07, 0.09, 0.11] as const),
    ax: pick(rng, [200, 280, 360] as const),
    az: pick(rng, [120, 180, 240] as const),
  };
}

export interface CorridorParams {
  /** Lateral lane selector, -1 | 0 | 1. */
  row: number;
  /** Phase offset along the corridor, 0.00-0.99. */
  phase: number;
}

/** Corridor stagger from the id hash only (unchanged since before T0). */
export function corridorParams(id: string): CorridorParams {
  const hash = hashString(id);
  return {
    row: ((hash >> 3) % 3) - 1,
    phase: ((hash >> 5) % 100) / 100,
  };
}

/** Corridor plan position: x along the band, z on the stagger lane. */
export function corridorPosition(
  travelSec: number,
  speedUnitsPerSec: number,
  id: string,
): { x: number; z: number } {
  const { row, phase } = corridorParams(id);
  const lap = (travelSec * speedUnitsPerSec + phase * CORRIDOR_WIDTH) % CORRIDOR_WIDTH;
  return { x: CORRIDOR_MIN_X + lap, z: row * 20 };
}

/** Ping-pong 0..1..0: traverse out and back with no teleport. */
function tri(u: number): number {
  const m = ((u % 2) + 2) % 2;
  return 1 - Math.abs(1 - m);
}

function clamp01(u: number): number {
  return u <= 0 ? 0 : u >= 1 ? 1 : u;
}

/** Smooth 0..1..0 hump over d seconds starting at t0 (zero slope at the ends). */
function pulse01(t: number, t0: number, d: number): number {
  const s = Math.sin(Math.PI * clamp01((t - t0) / d));
  return s * s;
}

export interface TrajectoryPoint {
  x: number;
  z: number;
  /** Altitude offset above the cruise floor, composed by main.ts. */
  altOffset: number;
}

type TrajectoryKind =
  | "corridor"
  | "weave"
  | "jink"
  | "orbit"
  | "approach"
  | "step"
  | "sweep";

const DISPATCH: Record<FlightPattern, TrajectoryKind> = {
  "straight-transit": "corridor",
  "wide-weave": "weave",
  "erratic-jink": "jink",
  "orbit-hold": "orbit",
  "direct-approach": "approach",
  "altitude-step": "step",
  "perimeter-sweep": "sweep",
};

const WEAVE_LEG = 1000;
const JINK_LEG = 900;

export function trajectoryPosition(
  pattern: FlightPattern | string | null | undefined,
  travelSec: number,
  speedUnitsPerSec: number,
  seed: number,
  id: string,
): TrajectoryPoint {
  const resolved = resolvePattern(pattern);
  const kind = DISPATCH[resolved];
  const t = Math.max(0, travelSec);
  const v = speedUnitsPerSec;

  if (kind === "corridor") {
    const { x, z } = corridorPosition(t, v, id);
    return { x, z, altOffset: 0 };
  }

  const p = deriveParams(seed, id, resolved);
  const trav = t * v;

  if (kind === "weave") {
    // Long traverse with a lateral sine; lane and amplitude keep |z| <= 300.
    const u = trav / WEAVE_LEG + p.phase;
    const x = p.dir > 0 ? -500 + tri(u) * WEAVE_LEG : 500 - tri(u) * WEAVE_LEG;
    const z = p.lane / 2 + p.amp * Math.sin((2 * Math.PI * p.cyc * trav) / WEAVE_LEG + p.p1);
    const altOffset = 10 * Math.sin((2 * Math.PI * trav) / WEAVE_LEG + p.p2);
    return { x, z, altOffset };
  }

  if (kind === "jink") {
    // Faster traverse with two non-harmonic lateral jinks plus a vertical bob.
    const u = trav / JINK_LEG + p.phase;
    const x = p.dir > 0 ? -450 + tri(u) * JINK_LEG : 450 - tri(u) * JINK_LEG;
    const z = p.amp * 0.5 * Math.sin(p.w1 * t + p.p1)
      + p.amp2 * Math.sin(p.w1 * p.wratio * t + p.p2);
    const altOffset = 15 * Math.sin(p.walt * t + p.p3);
    return { x, z, altOffset };
  }

  if (kind === "orbit") {
    // Closed ellipse around a seeded hold point; tangential rate tracks speed.
    const w = v / 150;
    const a = p.dir * w * t + p.p1;
    return {
      x: p.lane + p.rx * Math.cos(a),
      z: p.lane2 + p.rz * Math.sin(a),
      altOffset: p.alt,
    };
  }

  if (kind === "approach") {
    // Edge-to-site leg toward the ground-station area and back out. The site
    // sits near the mast so the approach reads as inbound, never as a hover.
    const ex = p.dir * 550;
    const ez = p.lane;
    const gx = 0;
    const gz = 100;
    const dist = Math.sqrt((gx - ex) * (gx - ex) + (gz - ez) * (gz - ez));
    const s = tri(trav / dist + p.phase);
    return {
      x: ex + (gx - ex) * s,
      z: ez + (gz - ez) * s,
      altOffset: 10 - 25 * s,
    };
  }

  if (kind === "step") {
    // Traverse on the far half of the box (opposite the corridor side) with
    // two smooth altitude steps; z holds a fixed wide lane.
    const u = trav / WEAVE_LEG + p.phase + 0.5;
    const x = p.dir > 0 ? -500 + tri(u) * WEAVE_LEG : 500 - tri(u) * WEAVE_LEG;
    const altOffset = p.a1 * pulse01(t, p.t1, p.dur) + p.a2 * pulse01(t, p.t1 + p.dt, p.dur);
    return { x, z: p.lane, altOffset };
  }

  if (kind === "sweep") {
    // Figure-eight patrol of the airspace; rate tracks speed so faster
    // contacts sweep visibly faster.
    const w = v / 200;
    return {
      x: p.ax * Math.sin(w * t + p.p1),
      z: p.az * Math.sin(2 * w * t + p.p2),
      altOffset: 10 * Math.sin(w * t + p.p3),
    };
  }

  // Exhaustive: kinds and branches grow together.
  throw new Error(`unimplemented trajectory kind: ${kind satisfies never}`);
}
