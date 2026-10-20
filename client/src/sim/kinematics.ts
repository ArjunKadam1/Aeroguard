// Airframe kinematics: the flown path an assigned guidance pattern produces
// once the airframe's physical limits are respected.
//
// trajectory.ts defines the intended path -- a closed-form guidance function
// of travel time. Real airframes cannot teleport their velocity onto it:
// - a quad can turn and climb hard, and accelerates quickly;
// - a fixed wing turns wide (bank-limited), climbs gently, and needs room to
//   change course.
// A point-mass model chases the guidance point with per-class turn-rate,
// acceleration, and climb-rate limits, so the flown path lags and cuts
// corners exactly where the hardware would.
//
// Guidance speed nuance: the pattern functions advance the guidance point by
// `speed` along the x axis, so lateral excursions make its true speed exceed
// the cruise value (up to ~2x on weave peaks, ~4x on jink peaks). The
// autopilot therefore commands a bounded path-following speed -- up to
// MAX_PATH_SPEED_FACTOR x cruise -- which keeps the lag per maneuver bounded
// instead of accumulating forever.
//
// Deterministic (NFR-01): fixed-step integration from travel 0, derived only
// from the guidance inputs, memoized per (seed, id, pattern, airframe,
// speed). The memo is a pure cache: any eviction merely forces an identical
// recomputation, never a different path.
//
// The corridor pattern is deliberately NOT flown through this model: it keeps
// the legacy closed-form lap-wrap semantics in threats.ts (a wrap is an
// abstraction, not a turnaround).

import type { FlightPattern } from "../api/types";
import {
  AIRSPACE_X,
  AIRSPACE_Z,
  ALT_OFFSET_MAX,
  ALT_OFFSET_MIN,
  resolvePattern,
  trajectoryPosition,
} from "./trajectory";

export type KinematicAirframe = "quad" | "wing";

export interface AirframeLimits {
  /** Maximum bank (wing) or tilt (quad) angle, degrees. */
  bankDeg: number;
  /** Structural turn-rate ceiling, deg/s, whatever the geometry allows. */
  maxTurnRateDeg: number;
  /** Maximum ground-speed change rate, units/s2. */
  accel: number;
  /** Maximum altitude-offset change rate, units/s. */
  climbRate: number;
}

// Quad: tilts hard (45 deg) and can pirouette up to its structural ceiling.
// Wing: bank-limited to 22 deg, so its turn radius grows with speed
// (R = v^2 / (g tan phi)) -- fast contacts corner visibly wider.
export const AIRFRAME_LIMITS: Record<KinematicAirframe, AirframeLimits> = {
  quad: { bankDeg: 45, maxTurnRateDeg: 90, accel: 4, climbRate: 3 },
  wing: { bankDeg: 22, maxTurnRateDeg: 45, accel: 1.5, climbRate: 1.5 },
};

/** World units are treated as metres for the bank-limited turn. */
export const GRAVITY_UNITS = 9.81;

/**
 * Speed-dependent turn-rate ceiling: a banked turn at speed v turns at
 * omega = g tan(phi) / v, capped by the structural limit. Faster flight
 * therefore corners wider -- the classic fixed-wing behaviour.
 */
export function turnRateLimitDeg(airframe: KinematicAirframe, speed: number): number {
  const limits = AIRFRAME_LIMITS[airframe];
  const banked = (GRAVITY_UNITS * Math.tan((limits.bankDeg * Math.PI) / 180)) / Math.max(speed, 0.1);
  return Math.min(limits.maxTurnRateDeg, (banked * 180) / Math.PI);
}

/** Integration step, seconds. Fixed so paths are frame-rate independent. */
export const STEP_S = 0.1;

/** Ceiling on the path-following speed, relative to the cruise speed. */
export const MAX_PATH_SPEED_FACTOR = 1.4;

/**
 * The autopilot aims at the guidance point this many seconds ahead: like a
 * real path follower, it tracks the path's tangent rather than chasing the
 * point under its nose, so hardware limits bind exactly when the geometry
 * demands more than the airframe can give.
 */
export const LOOKAHEAD_S = 1.5;

/** Hard cap on one integrated track (10 minutes of travel). */
const MAX_STEPS = 6000;

const MAX_CACHE_ENTRIES = 64;

export interface KinematicPoint {
  x: number;
  z: number;
  altOffset: number;
  /** Direction of travel, radians, atan2(dz, dx). */
  headingRad: number;
  /** Achieved turn rate over the latest step, deg/s (signed). */
  turnRateDeg: number;
  /** Ground speed, units/s. */
  speed: number;
}

const cache = new Map<string, KinematicPoint[]>();

function wrapSignedRad(angle: number): number {
  return ((angle + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function initialPoint(
  pattern: FlightPattern,
  speed: number,
  seed: number,
  id: string,
): KinematicPoint {
  const start = trajectoryPosition(pattern, 0, speed, seed, id);
  // Same aim convention as advance(), so the launch heading blends in.
  const aim = trajectoryPosition(pattern, LOOKAHEAD_S, speed, seed, id);
  const dx = aim.x - start.x;
  const dz = aim.z - start.z;
  return {
    x: start.x,
    z: start.z,
    altOffset: start.altOffset,
    headingRad: dx === 0 && dz === 0 ? 0 : Math.atan2(dz, dx),
    turnRateDeg: 0,
    speed: 0,
  };
}

function advance(
  pattern: FlightPattern,
  airframe: KinematicAirframe,
  cruiseSpeed: number,
  seed: number,
  id: string,
  step: number,
  prev: KinematicPoint,
): KinematicPoint {
  const limits = AIRFRAME_LIMITS[airframe];
  const guide = trajectoryPosition(pattern, (step + 1) * STEP_S, cruiseSpeed, seed, id);
  const nextGuide = trajectoryPosition(pattern, (step + 2) * STEP_S, cruiseSpeed, seed, id);
  const aim = trajectoryPosition(
    pattern,
    (step + 1) * STEP_S + LOOKAHEAD_S,
    cruiseSpeed,
    seed,
    id,
  );
  const desiredHeading = Math.atan2(aim.z - prev.z, aim.x - prev.x);
  const maxTurn = (turnRateLimitDeg(airframe, prev.speed) * Math.PI) / 180 * STEP_S;
  const turn = clamp(wrapSignedRad(desiredHeading - prev.headingRad), -maxTurn, maxTurn);
  const headingRad = prev.headingRad + turn;
  // Command the speed needed to hold the path, within the airframe's budget.
  const guideSpeed = Math.hypot(nextGuide.x - guide.x, nextGuide.z - guide.z) / STEP_S;
  const targetSpeed = Math.max(0, Math.min(cruiseSpeed * MAX_PATH_SPEED_FACTOR, guideSpeed));
  const nextSpeed = clamp(
    targetSpeed,
    prev.speed - limits.accel * STEP_S,
    prev.speed + limits.accel * STEP_S,
  );
  const x = clamp(prev.x + Math.cos(headingRad) * nextSpeed * STEP_S, -AIRSPACE_X, AIRSPACE_X);
  const z = clamp(prev.z + Math.sin(headingRad) * nextSpeed * STEP_S, -AIRSPACE_Z, AIRSPACE_Z);
  const maxClimb = limits.climbRate * STEP_S;
  const altOffset = clamp(
    prev.altOffset + clamp(guide.altOffset - prev.altOffset, -maxClimb, maxClimb),
    ALT_OFFSET_MIN,
    ALT_OFFSET_MAX,
  );
  return {
    x,
    z,
    altOffset,
    headingRad,
    turnRateDeg: (wrapSignedRad(headingRad - prev.headingRad) / STEP_S) * (180 / Math.PI),
    speed: nextSpeed,
  };
}

function trackFor(
  pattern: FlightPattern,
  airframe: KinematicAirframe,
  speed: number,
  seed: number,
  id: string,
): KinematicPoint[] {
  const key = `${seed}|${id}|${pattern}|${airframe}|${speed}`;
  const cached = cache.get(key);
  if (cached) return cached;
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  const track = [initialPoint(pattern, speed, seed, id)];
  cache.set(key, track);
  return track;
}

/** Flown state at a travel time (seconds since spawn) for one contact. */
export function flownPoint(
  pattern: FlightPattern | string | null | undefined,
  airframe: KinematicAirframe,
  speed: number,
  seed: number,
  id: string,
  travelSec: number,
): KinematicPoint {
  const resolved = resolvePattern(pattern);
  if (resolved === "straight-transit") {
    // Legacy corridor: exact closed-form path, no dynamics (see header).
    const point = trajectoryPosition(resolved, Math.max(0, travelSec), speed, seed, id);
    return { x: point.x, z: point.z, altOffset: point.altOffset, headingRad: 0, turnRateDeg: 0, speed };
  }
  const travel = Math.max(0, travelSec);
  const track = trackFor(resolved, airframe, speed, seed, id);
  const lastIndex = Math.min(Math.floor(travel / STEP_S), MAX_STEPS - 1);
  // Keep one sample ahead so every query can interpolate between steps.
  while (track.length <= lastIndex + 1 && track.length < MAX_STEPS) {
    track.push(
      advance(resolved, airframe, speed, seed, id, track.length - 1, track[track.length - 1]),
    );
  }
  if (lastIndex >= track.length - 1) {
    // Beyond the integrated cap: hold the final state. Unreachable in a real
    // session (10 minutes of travel); guards pathological elapsed values.
    return { ...track[track.length - 1] };
  }
  const base = track[lastIndex];
  const next = track[lastIndex + 1];
  const f = clamp(travel / STEP_S - lastIndex, 0, 1);
  return {
    x: base.x + (next.x - base.x) * f,
    z: base.z + (next.z - base.z) * f,
    altOffset: base.altOffset + (next.altOffset - base.altOffset) * f,
    headingRad: base.headingRad + wrapSignedRad(next.headingRad - base.headingRad) * f,
    turnRateDeg: base.turnRateDeg + (next.turnRateDeg - base.turnRateDeg) * f,
    speed: base.speed + (next.speed - base.speed) * f,
  };
}
