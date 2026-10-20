// Small-UAS swarm presentation: a swarm-capable contact flies as a tight
// three-drone formation -- one lead (the contact the sensor sees) and two
// escorts wandering around station-keeping slots.
//
// Why escorts are visual-only: the sensor, scoring, and replay all run from
// the lead's plan position (one contact, one echo). A tight formation is a
// single radar resolution cell in reality, so the radar showing one track is
// correct; the high-fidelity world view shows the individual airframes. This
// is deliberately NOT three contacts -- adding unscored contacts would change
// scenario semantics.
//
// The escort motion is a reduced boids model in the lead's local frame:
// - cohesion: a spring pulls each escort toward its formation slot;
// - separation: escorts push away from the lead and each other when closer
//   than SEPARATION_MIN (safety; nominal slots sit well outside it);
// - wander: seeded smooth drift so the trio never looks welded together.
// There is no alignment term: the formation frame already carries the lead's
// velocity and heading, so members inherit both.
//
// Deterministic (NFR-01): fixed-step integration from travel 0, seeded only
// by (seed, id), memoized per (seed, id). Any cache eviction merely forces an
// identical recomputation. Offsets are clamped to a small box: the trio must
// stay tight enough to read as one contact, never a formation of its own.

import { hashString } from "./trajectory";

export interface EscortOffset {
  x: number;
  y: number;
  z: number;
}

/** Fixed formation slots in the lead's local frame (+x = direction of travel). */
export const ESCORT_SLOTS: readonly EscortOffset[] = [
  { x: -4.5, y: 0.6, z: 5.0 },
  { x: -5.5, y: -0.4, z: -4.5 },
];

export const ESCORT_COUNT = ESCORT_SLOTS.length;

/** Integration step, seconds. Fixed so motion is frame-rate independent. */
export const FORMATION_STEP_S = 0.1;

// Boid gains. The slot spring plus damping dominate; the wander accelerations
// are far below resonance, so members swing ~1 unit around their slots.
const SLOT_GAIN = 1.1;
const DAMPING = 0.94;
const WANDER_ACCEL = 1.0;
const WANDER_Y_ACCEL = 0.35;
const SEPARATION_MIN = 2.8;
const SEPARATION_GAIN = 4.0;
const MAX_SPEED = 2.5;
const BOX_XZ = 9;
const BOX_Y = 2.2;

/** Hard cap on one integrated track (10 minutes of travel). */
const MAX_STEPS = 6000;
const MAX_CACHE_ENTRIES = 64;

interface Frame {
  offsets: EscortOffset[];
}

interface Velocity {
  vx: number;
  vy: number;
  vz: number;
}

interface Track {
  frames: Frame[];
  velocities: Velocity[];
  wander: Array<{ w1: number; w2: number; w3: number; p1: number; p2: number; p3: number }>;
}

const cache = new Map<string, Track>();

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Seeded wander parameters per escort, stable for (seed, id, index). */
function wanderFor(seed: number, id: string, index: number): Track["wander"][number] {
  const h = hashString(`${seed}|${id}|swarm|${index}`);
  return {
    w1: 0.18 + (h % 17) / 100,
    w2: 0.21 + ((h >> 4) % 19) / 100,
    w3: 0.15 + ((h >> 8) % 13) / 100,
    p1: (h % 628) / 100,
    p2: ((h >> 6) % 628) / 100,
    p3: ((h >> 12) % 628) / 100,
  };
}

function initialFrame(): Frame {
  return { offsets: ESCORT_SLOTS.map((slot) => ({ ...slot })) };
}

function trackFor(seed: number, id: string): Track {
  const key = `${seed}|${id}`;
  const cached = cache.get(key);
  if (cached) return cached;
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  const track: Track = {
    frames: [initialFrame()],
    velocities: ESCORT_SLOTS.map(() => ({ vx: 0, vy: 0, vz: 0 })),
    wander: ESCORT_SLOTS.map((_, index) => wanderFor(seed, id, index)),
  };
  cache.set(key, track);
  return track;
}

/** Integrate one boids step for the whole trio at once (separation needs it). */
function advance(track: Track, step: number): Frame {
  const prev = track.frames[step].offsets;
  const next: EscortOffset[] = ESCORT_SLOTS.map((slot, i) => {
    const pos = prev[i];
    const vel = track.velocities[i];
    const w = track.wander[i];
    const t = (step + 1) * FORMATION_STEP_S;

    let ax = SLOT_GAIN * (slot.x - pos.x) + WANDER_ACCEL * Math.sin(w.w1 * t + w.p1);
    let az = SLOT_GAIN * (slot.z - pos.z) + WANDER_ACCEL * Math.sin(w.w2 * t + w.p2);

    // Separation from the lead at the local origin.
    const leadDistance = Math.hypot(pos.x, pos.z);
    if (leadDistance < SEPARATION_MIN) {
      const push = (SEPARATION_MIN - leadDistance) * SEPARATION_GAIN;
      const nx = leadDistance > 1e-6 ? pos.x / leadDistance : 0;
      const nz = leadDistance > 1e-6 ? pos.z / leadDistance : 1;
      ax += nx * push;
      az += nz * push;
    }

    // Separation from the other escort.
    for (let j = 0; j < prev.length; j += 1) {
      if (j === i) continue;
      const dx = pos.x - prev[j].x;
      const dz = pos.z - prev[j].z;
      const distance = Math.hypot(dx, dz);
      if (distance < SEPARATION_MIN) {
        const push = (SEPARATION_MIN - distance) * SEPARATION_GAIN;
        const nx = distance > 1e-6 ? dx / distance : 0;
        const nz = distance > 1e-6 ? dz / distance : 1;
        ax += nx * push;
        az += nz * push;
      }
    }

    const ay = SLOT_GAIN * (slot.y - pos.y) + WANDER_Y_ACCEL * Math.sin(w.w3 * t + w.p3);

    vel.vx = (vel.vx + ax * FORMATION_STEP_S) * DAMPING;
    vel.vz = (vel.vz + az * FORMATION_STEP_S) * DAMPING;
    vel.vy = (vel.vy + ay * FORMATION_STEP_S) * DAMPING;
    const speed = Math.hypot(vel.vx, vel.vz, vel.vy);
    if (speed > MAX_SPEED) {
      const scale = MAX_SPEED / speed;
      vel.vx *= scale;
      vel.vz *= scale;
      vel.vy *= scale;
    }

    return {
      x: clamp(pos.x + vel.vx * FORMATION_STEP_S, -BOX_XZ, BOX_XZ),
      y: clamp(pos.y + vel.vy * FORMATION_STEP_S, -BOX_Y, BOX_Y),
      z: clamp(pos.z + vel.vz * FORMATION_STEP_S, -BOX_XZ, BOX_XZ),
    };
  });
  track.frames.push({ offsets: next });
  return track.frames[track.frames.length - 1];
}

/**
 * Escort offsets in the lead's local frame at a travel time (seconds since
 * spawn). Always ESCORT_COUNT entries; offsets are interpolated between the
 * fixed integration steps so motion is smooth at any frame rate.
 */
export function escortOffsets(seed: number, id: string, travelSec: number): EscortOffset[] {
  const travel = Math.max(0, travelSec);
  const track = trackFor(seed, id);
  const lastIndex = Math.min(Math.floor(travel / FORMATION_STEP_S), MAX_STEPS - 1);
  while (track.frames.length <= lastIndex + 1 && track.frames.length < MAX_STEPS) {
    advance(track, track.frames.length - 1);
  }
  if (lastIndex >= track.frames.length - 1) {
    return track.frames[track.frames.length - 1].offsets.map((offset) => ({ ...offset }));
  }
  const base = track.frames[lastIndex].offsets;
  const next = track.frames[lastIndex + 1].offsets;
  const f = clamp(travel / FORMATION_STEP_S - lastIndex, 0, 1);
  return base.map((offset, i) => ({
    x: offset.x + (next[i].x - offset.x) * f,
    y: offset.y + (next[i].y - offset.y) * f,
    z: offset.z + (next[i].z - offset.z) * f,
  }));
}

// --- Scenario-declared swarms -----------------------------------------------
// A true swarm is several separately scored contacts flying together (members
// arrive with a swarm_id in the public scenario). Unlike the decorative
// escorts above, members must stay far enough apart to be resolved as
// individual contacts, so the slots are loose: mid-30s of lateral spacing and
// 26 units of trail. A slow seeded wander keeps the formation from looking
// welded together without ever closing that spacing.

/** Local trail behind the lead for each formation row, world units. */
export const SWARM_TRAIL = 26;
/** Local lateral spacing per formation row, world units. */
export const SWARM_LATERAL = 36;

/** Station-keeping slot in the lead's local frame (+x = travel). */
export function swarmSlot(index: number): EscortOffset {
  if (index <= 0) return { x: 0, y: 0, z: 0 };
  const row = Math.ceil(index / 2);
  const side = index % 2 === 1 ? 1 : -1;
  return {
    x: -row * SWARM_TRAIL,
    y: ((index % 3) - 1) * 3,
    z: side * row * SWARM_LATERAL,
  };
}

/**
 * Seeded smooth offset for one swarm member at a travel time (seconds since
 * the group spawned). Deterministic and frame-rate independent: the wander is
 * analytic, so any query order returns the same position.
 */
export function swarmOffsetAt(
  seed: number,
  id: string,
  index: number,
  travelSec: number,
): EscortOffset {
  const slot = swarmSlot(index);
  const travel = Math.max(0, travelSec);
  const h = hashString(`${seed}|${id}|swarm:wander`);
  const wx = 0.08 + (h % 9) / 100;
  const wz = 0.10 + ((h >> 5) % 9) / 100;
  const wy = 0.16 + ((h >> 10) % 9) / 100;
  const px = (h % 628) / 100;
  const pz = ((h >> 6) % 628) / 100;
  const py = ((h >> 12) % 628) / 100;
  return {
    x: slot.x + 7 * Math.sin(wx * travel + px),
    y: slot.y + 2.2 * Math.sin(wy * travel + py),
    z: slot.z + 7 * Math.sin(wz * travel + pz),
  };
}
