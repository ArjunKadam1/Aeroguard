// Observer sensor model: what each operator role can actually observe.
//
// Ground truth (where contacts really are) lives in the scenario and the 3D
// scene. This module maps it to per-observer observations through two separate
// capabilities:
//
// - Visual: short-range, orientation-dependent (the trainee must aim the
//   sensor at the contact), degraded by night/visibility/sensor quality.
// - Radar-like: longer-range, orientation-independent abstract blips with
//   bearing and range but no identity detail, refreshed on intermittent
//   sweeps and degraded by sensor quality. The station mast has no radar.
//
// Detections feed a unified track manager: tentative -> confirmed ->
// coasting -> dropped. Visual association confirms immediately (a camera
// resolves identity); radar-only tracks need repeated hits. Seeded false
// radar contacts exercise the false-alarm path. Everything is deterministic
// for a fixed seed and observer path, on fixed time quanta -- never on frame
// rate -- so 60 Hz and 144 Hz runs observe identically.
//
// Pure functions, no Three.js, so the whole model is unit-testable. The 3D
// scene still renders spawned contacts when in frame (no render culling);
// the model gates *decisions* (detect/classify), which is what scoring
// measures, not pixels.

import { STATION_POSITION, stationLookTarget } from "./aircraft";

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export type ObserverKind = "station" | "scout";

export interface Observer {
  kind: ObserverKind;
  position: Vec3;
  /** Visual axis. Need not be unit length; normalized internally. */
  lookDirection: Vec3;
  /** Visual half-angle in radians. */
  visualHalfFov: number;
  visualRange: number;
  /** 0 means no radar fitted (the station mast). */
  radarRange: number;
  /** Seconds between radar sweeps. */
  radarPeriod: number;
}

export type VisibilityTier = "clear" | "reduced" | "poor";

export interface SensorConditions {
  sensorQuality: number;
  night: boolean;
  visibility: VisibilityTier;
}

export interface ContactTruth {
  id: string;
  position: Vec3;
  spawned: boolean;
}

export interface ContactObservation {
  id: string;
  visual: boolean;
  radar: boolean;
  /** Degrees, 0 = -Z, clockwise. */
  bearingDeg: number;
  range: number;
}

export interface Detection {
  id: string;
  bearingDeg: number;
  range: number;
}

// --- Sensor performance ----------------------------------------------------
// Ranges are in world units. The corridor spans ~120 units across and the
// world is thousands wide: the scout must close distance and aim, while the
// mast's telephoto optics make the station's skill panning, not proximity.

export const SCOUT_VISUAL_RANGE = 150;
export const STATION_VISUAL_RANGE = 1200;
export const STATION_HALF_FOV = 0.5;
export const SCOUT_RADAR_RANGE = 400;
export const RADAR_PERIOD_S = 2;
export const RADAR_BEARING_NOISE_DEG = 12;

// --- Tracking ----------------------------------------------------------------
// Track ticks quantize elapsed session time so observation is frame-rate
// independent. A contact seen this tick is fresh; missed ticks coast on the
// last fix; older tracks drop.

/** Seconds per track tick. */
export const TRACK_TICK_S = 0.5;
/** Consecutive missed ticks before a track drops (2 seconds of silence). */
export const TRACK_MAX_STALE_TICKS = 4;
/** Radar-only hits needed to confirm (a camera confirms on first sight). */
export const RADAR_CONFIRM_HITS = 2;
/** Seeded false-contact slots per sweep. Conservative by design. */
export const MAX_FALSE_TRACKS = 2;

export type TrackSource = "visual" | "radar" | "both";

export interface Track {
  id: string;
  /** Sensors holding the contact as of lastTick. */
  lastSource: TrackSource;
  /** Whether any association was ever visual: unlocks classification. */
  seenVisual: boolean;
  hits: number;
  lastTick: number;
  bearingDeg: number;
  range: number;
}

export type TrackState = "tentative" | "confirmed" | "coasting";

/** Lifecycle state of a track at a tick. Coasting tracks stay actionable
 * until they drop: a contact seen clearly a second ago is still evidence. */
export function trackState(track: Track, tick: number): TrackState {
  if (tick > track.lastTick) return "coasting";
  if (track.seenVisual || track.hits >= RADAR_CONFIRM_HITS) return "confirmed";
  return "tentative";
}

export interface SensorPermissions {
  /** The contact is registered by some sensor: detection is meaningful. */
  detect: boolean;
  /** The sensor resolves identity detail: classification is meaningful. */
  classify: boolean;
}

/**
 * What the trainee may do with a track, from sensors alone. Radar-only
 * tracks can be detected but not classified -- the radar reports existence
 * and position, never identity. Response gating stays with the session stage
 * machine, which requires classification first anyway.
 */
export function trackPermissions(track: Track | null): SensorPermissions {
  if (!track) return { detect: false, classify: false };
  return { detect: true, classify: track.seenVisual };
}

const VISIBILITY_FACTOR: Record<VisibilityTier, number> = {
  clear: 1,
  reduced: 0.8,
  poor: 0.55,
};
const NIGHT_FACTOR = 0.7;

// --- Deterministic rolls ---------------------------------------------------

function hash32(key: string): number {
  // FNV-1a, matching the id-hash style used for threat colors.
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i += 1) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Stable pseudo-random value in [0, 1) for a key. Same key, same value. */
export function roll01(key: string): number {
  let state = hash32(key) || 1;
  // One mulberry32 step is plenty for a threshold roll.
  state |= 0;
  state = (state + 0x6d2b79f5) | 0;
  let t = Math.imul(state ^ (state >>> 15), 1 | state);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// --- Geometry --------------------------------------------------------------

function subtract(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function lengthOf(v: Vec3): number {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}

function angleBetween(a: Vec3, b: Vec3): number {
  const la = lengthOf(a);
  const lb = lengthOf(b);
  if (la === 0 || lb === 0) return Math.PI;
  const cos = (a.x * b.x + a.y * b.y + a.z * b.z) / (la * lb);
  return Math.acos(Math.max(-1, Math.min(1, cos)));
}

export function bearingDegOf(delta: Vec3): number {
  const degrees = (Math.atan2(delta.x, -delta.z) * 180) / Math.PI;
  return ((degrees % 360) + 360) % 360;
}

// --- Observers -------------------------------------------------------------

export function stationObserver(heading: number): Observer {
  const aim = stationLookTarget(heading);
  return {
    kind: "station",
    position: { ...STATION_POSITION },
    lookDirection: {
      x: aim.x - STATION_POSITION.x,
      y: aim.y - STATION_POSITION.y,
      z: aim.z - STATION_POSITION.z,
    },
    visualHalfFov: STATION_HALF_FOV,
    visualRange: STATION_VISUAL_RANGE,
    radarRange: 0,
    radarPeriod: RADAR_PERIOD_S,
  };
}

export function scoutObserver(position: Vec3, lookDirection: Vec3): Observer {
  return {
    kind: "scout",
    position: { ...position },
    lookDirection: { ...lookDirection },
    // Matches the 60-degree render camera: what the trainee sees is what the
    // visual sensor sees. Nothing more.
    visualHalfFov: (60 * Math.PI) / 360,
    visualRange: SCOUT_VISUAL_RANGE,
    radarRange: SCOUT_RADAR_RANGE,
    radarPeriod: RADAR_PERIOD_S,
  };
}

/** Sweep index for an elapsed session time. Radar only updates on new ticks. */
export function radarTick(elapsedS: number, period: number = RADAR_PERIOD_S): number {
  return Math.floor(Math.max(0, elapsedS) / period);
}

/** Track-tick index for an elapsed session time. */
export function trackTick(elapsedS: number): number {
  return Math.floor(Math.max(0, elapsedS) / TRACK_TICK_S);
}

// --- Observation -----------------------------------------------------------

function visualProbability(conditions: SensorConditions): number {
  const p = conditions.sensorQuality
    * VISIBILITY_FACTOR[conditions.visibility]
    * (conditions.night ? NIGHT_FACTOR : 1);
  return Math.max(0, Math.min(1, p));
}

function radarProbability(conditions: SensorConditions): number {
  return Math.max(0, Math.min(1, conditions.sensorQuality * 1.2 - 0.1));
}

export function observeContact(
  observer: Observer,
  contact: ContactTruth,
  conditions: SensorConditions,
  seed: number,
  tick: number,
): ContactObservation {
  const delta = subtract(contact.position, observer.position);
  const range = lengthOf(delta);
  const bearing = bearingDegOf(delta);
  if (!contact.spawned) {
    return { id: contact.id, visual: false, radar: false, bearingDeg: bearing, range };
  }

  let visual = false;
  if (range <= observer.visualRange
    && angleBetween(observer.lookDirection, delta) <= observer.visualHalfFov) {
    // Keyed by tick: sensors miss intermittently under degradation, and the
    // track lifecycle (not the instantaneous roll) decides what the trainee
    // may act on. At perfect conditions the probability is 1, so aiming is
    // always enough and nothing is ever permanently locked out.
    visual = roll01(`${seed}|${contact.id}|visual:${tick}`) < visualProbability(conditions);
  }

  let radar = false;
  let radarBearing = bearing;
  if (observer.radarRange > 0 && range <= observer.radarRange) {
    const roll = roll01(`${seed}|${contact.id}|radar:${tick}`);
    if (roll < radarProbability(conditions)) {
      radar = true;
      const noise = (roll01(`${seed}|${contact.id}|bearing:${tick}`) - 0.5) * RADAR_BEARING_NOISE_DEG;
      radarBearing = ((bearing + noise) % 360 + 360) % 360;
    }
  }
  return { id: contact.id, visual, radar, bearingDeg: radarBearing, range };
}

/** Visual-channel detections for one track tick. */
export function detectVisual(
  observer: Observer,
  contacts: readonly ContactTruth[],
  conditions: SensorConditions,
  seed: number,
  tick: number,
): Detection[] {
  const out: Detection[] = [];
  for (const contact of contacts) {
    const obs = observeContact(observer, contact, conditions, seed, tick);
    if (obs.visual) out.push({ id: contact.id, bearingDeg: obs.bearingDeg, range: obs.range });
  }
  return out;
}

/** Radar-channel detections for one sweep. Pass the sweep index as tick. */
export function detectRadar(
  observer: Observer,
  contacts: readonly ContactTruth[],
  conditions: SensorConditions,
  seed: number,
  sweepIndex: number,
): Detection[] {
  const out: Detection[] = [];
  for (const contact of contacts) {
    const obs = observeContact(observer, contact, conditions, seed, sweepIndex);
    if (obs.radar) out.push({ id: contact.id, bearingDeg: obs.bearingDeg, range: obs.range });
  }
  return out;
}

// --- False contacts ----------------------------------------------------------

function falseProbability(conditions: SensorConditions): number {
  const p = (1 - conditions.sensorQuality) * 0.3
    + (conditions.visibility === "poor" ? 0.1 : 0);
  return Math.max(0, Math.min(0.5, p));
}

/**
 * Seeded transient false radar contacts for one sweep. Same seed, sweep, and
 * conditions always yield the same schedule. Conservative by design: at most
 * two concurrent blips, radar-only (never classifiable), and none at all
 * under perfect conditions. Detecting one records a false alarm through the
 * existing penalty path; scoring denominators never see them.
 */
export function falseDetections(
  seed: number,
  sweepIndex: number,
  conditions: SensorConditions,
): Detection[] {
  const out: Detection[] = [];
  const probability = falseProbability(conditions);
  if (probability <= 0) return out;
  for (let slot = 0; slot < MAX_FALSE_TRACKS; slot += 1) {
    if (roll01(`${seed}|false:${sweepIndex}:${slot}`) >= probability) continue;
    out.push({
      id: `F-0${slot + 1}`,
      bearingDeg: roll01(`${seed}|false-bearing:${sweepIndex}:${slot}`) * 360,
      range: 100 + roll01(`${seed}|false-range:${sweepIndex}:${slot}`) * 250,
    });
  }
  return out;
}

// --- Track manager -----------------------------------------------------------

/**
 * Maintain unified tracks across ticks. Visual association confirms
 * immediately; radar-only tracks need repeated hits; missed ticks coast on
 * the last fix; older tracks drop. Pure so the lifecycle is exactly testable.
 */
export function updateTracks(
  previous: readonly Track[],
  visual: ReadonlyArray<Detection>,
  radar: ReadonlyArray<Detection>,
  tick: number,
  maxStaleTicks: number = TRACK_MAX_STALE_TICKS,
): Track[] {
  const visualById = new Map(visual.map((d) => [d.id, d]));
  const radarById = new Map(radar.map((d) => [d.id, d]));
  const oldById = new Map(previous.map((t) => [t.id, t]));
  const next: Track[] = [];
  const ids = new Set([...visualById.keys(), ...radarById.keys(), ...oldById.keys()]);
  for (const id of ids) {
    const sighting = visualById.get(id);
    const echo = radarById.get(id);
    const old = oldById.get(id);
    if (!sighting && !echo) {
      if (old && tick - old.lastTick <= maxStaleTicks) next.push(old);
      continue;
    }
    const point = sighting ?? echo!;
    next.push({
      id,
      lastSource: sighting && echo ? "both" : sighting ? "visual" : "radar",
      seenVisual: (old?.seenVisual ?? false) || sighting !== undefined,
      hits: (old?.hits ?? 0) + 1,
      lastTick: tick,
      bearingDeg: point.bearingDeg,
      range: point.range,
    });
  }
  return next;
}
