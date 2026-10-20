// AI-assisted mode: which abstract action a contact is due, and how the sensor
// is oriented to acquire a visual track.
//
// Pure functions, no DOM and no network, so the assistant's pacing and gating
// are unit-testable. The boundaries this module keeps:
//
// - Decisions themselves come from the backend assistant endpoint, which sees
//   public evidence only. This module never reads a hidden label, and it never
//   picks a classification or response on its own.
// - Every action is returned as an AssistAction for main.ts to apply through
//   the SessionController's normal methods, so the assistant can never bypass
//   the state machine, a gate, or the scoring path.
// - Orientation is navigation only. It flies the simulated airframe and slews
//   the simulated mast; it controls no real system.

import { STATION_AIM, STATION_POSITION } from "./aircraft";
import type { FlightInput, Vec3 } from "./flight";
import { STATION_SWEEP_RATE } from "./picking";
import type { ResponseClass, ResponseState } from "./response";
import type { ThreatStage } from "../state/session";

/** Seconds between assistant decisions: deliberate, never per frame. */
export const ASSIST_INTERVAL_S = 0.7;
/**
 * Airborne: horizontal standoff once the contact is close enough for a look.
 * Comfortably inside the scout's 150-unit visual range, and close enough that
 * a bearing fix's lateral error stays small.
 */
export const SCOUT_HOLD_RANGE = 70;
/** Airborne: throttle that roughly cancels gravity (THRUST_MAX / GRAVITY). */
export const HOVER_THROTTLE = 0.53;
/** Airborne search orbit: radius and period around the corridor centre. */
export const SCOUT_PATROL_RADIUS = 260;
export const SCOUT_PATROL_PERIOD_S = 90;

// Approach control bands. Distances in world units, angles in radians. The
// controller is deliberately smooth: bang-bang thrust made the scout surge,
// coast and weave around the standoff instead of settling on it.
const SCOUT_ALT_DEADBAND = 6;
const SCOUT_ARRIVE_BAND = 20;
const SCOUT_CLOSE_BAND = 60;
const SCOUT_YAW_DEADBAND = 0.02;
/** Full-stick forward: the same authority the trainee has by hand. */
const SCOUT_MAX_FORWARD = 0.9;
/** Aim smoothing time constant, seconds: removes fix-to-fix jitter, not motion. */
const AIM_SMOOTHING_S = 0.35;

export type AssistWorkflowState = "none" | ResponseState;

/** The assistant's view of one contact, built from public state only. */
export interface AssistContact {
  id: string;
  stage: ThreatStage;
  /** Any sensor track currently holds the contact. */
  tracked: boolean;
  /** A visual track currently resolves the contact (classification is legal). */
  visual: boolean;
  /** Simulated-measure workflow state for the contact. */
  workflow: AssistWorkflowState;
}

export type AssistAction =
  | { kind: "detect"; id: string }
  | { kind: "classify"; id: string }
  | { kind: "respond"; id: string }
  | { kind: "request"; id: string }
  | { kind: "approve"; id: string };

/**
 * The next step for every contact the assistant can advance, one step per
 * contact. Order follows the scenario's contact order (oldest arrival first),
 * so a multi-contact picture is worked in the order contacts appeared.
 * `pending` holds contacts with a decision request already in flight.
 */
export function nextAssistActions(
  contacts: readonly AssistContact[],
  pending: ReadonlySet<string>,
): AssistAction[] {
  const actions: AssistAction[] = [];
  for (const contact of contacts) {
    if (pending.has(contact.id)) continue;
    if (contact.stage === "spawned" && contact.tracked) {
      actions.push({ kind: "detect", id: contact.id });
      continue;
    }
    if (contact.stage === "detected" && contact.visual) {
      actions.push({ kind: "classify", id: contact.id });
      continue;
    }
    if (contact.stage === "classified") {
      actions.push({ kind: "respond", id: contact.id });
      continue;
    }
    if (contact.stage === "responded") {
      // An approved simulation resolves on its own; no action needed.
      if (contact.workflow === "ready") actions.push({ kind: "request", id: contact.id });
      else if (contact.workflow === "awaiting_approval") {
        actions.push({ kind: "approve", id: contact.id });
      }
    }
  }
  return actions;
}

/**
 * Where the sensor should be pointed, and whether a search is warranted.
 *
 * - `target`: an observed contact still waiting for a classification. The
 *   assistant holds the fix instead of leaving a contact it has already seen.
 * - `search`: no pending contact is observed, but at least one still needs a
 *   classification, so the sensor must keep looking. In the station that means
 *   a mast sweep; the scout's radar is orientation-independent (range-limited),
 *   so the airborne search is positional instead.
 */
export interface AssistAim {
  target: string | null;
  search: boolean;
}

export function assistAim(
  contacts: readonly AssistContact[],
  current: string | null = null,
): AssistAim {
  const pending = contacts.filter(
    (contact) => contact.stage === "spawned" || contact.stage === "detected",
  );
  if (pending.length === 0) return { target: null, search: false };
  // Stay with the contact already being worked while it is still tracked.
  // Switching the aim every time another track flickers makes the sensor (and
  // the scout) weave across the picture.
  if (current !== null) {
    const held = pending.find((contact) => contact.id === current && contact.tracked);
    if (held !== undefined) return { target: held.id, search: false };
  }
  const observed = pending.find((contact) => contact.tracked);
  if (observed !== undefined) return { target: observed.id, search: false };
  // Every pending contact is still unobserved: look for one.
  return { target: null, search: true };
}

/** Abstract response class for the simulated measure: hostile gets the
 * authorization class, everything else the mitigation class. */
export function assistResponseClass(classification: string): ResponseClass {
  return classification === "hostile" ? "weapon-class" : "mitigation";
}

// --- Orientation ------------------------------------------------------------

/** Wrap to [0, 2π). */
export function wrapTwoPi(radians: number): number {
  const full = Math.PI * 2;
  return ((radians % full) + full) % full;
}

/** Wrap to [-π, π): the shortest signed difference between two angles. */
export function shortestAngle(radians: number): number {
  const full = Math.PI * 2;
  return ((((radians + Math.PI) % full) + full) % full) - Math.PI;
}

// Bearing (0 = -Z, clockwise) of the mast's default aim point, so a target
// bearing can be converted into the mast heading that points at it.
const STATION_AIM_BEARING = Math.atan2(
  STATION_AIM.x - STATION_POSITION.x,
  -(STATION_AIM.z - STATION_POSITION.z),
);

/** Mast heading that looks straight at a world position. */
export function stationHeadingFor(target: Vec3): number {
  const x = target.x - STATION_POSITION.x;
  const z = target.z - STATION_POSITION.z;
  return wrapTwoPi(Math.atan2(x, -z) - STATION_AIM_BEARING);
}

/**
 * Slew the mast toward a heading at the trainee's own sweep rate, so the
 * assistant searches no faster than the operator could.
 */
export function slewHeading(current: number, target: number, dt: number): number {
  const step = Math.max(0, Math.min(dt, 0.1)) * STATION_SWEEP_RATE;
  const error = shortestAngle(target - current);
  if (Math.abs(error) <= step) return wrapTwoPi(target);
  return wrapTwoPi(current + Math.sign(error) * step);
}

/** Options for the assisted autopilot. */
export interface AutopilotOptions {
  /** Horizontal standoff to hold from the target. Defaults to the visual hold. */
  standoff?: number;
  /** Current airframe velocity, used to damp the vertical loop. */
  velocity?: Vec3;
}

/**
 * Autopilot input for the airborne assistant. The controller is proportional
 * rather than bang-bang:
 *
 * - yaw turns toward the target and stops commanding inside a small deadband;
 * - forward thrust scales with nose alignment and distance, so the scout arcs
 *   toward the contact instead of flying out along its old nose while the turn
 *   completes, and eases into the standoff instead of surging through it;
 * - inside the standoff it brakes (reverse thrust, within the trainee's own
 *   control authority) rather than coasting past the contact;
 * - throttle holds altitude with proportional + velocity damping, so a long
 *   climb does not overshoot and have to come back.
 *
 * A null target hovers in place. `standoff` 0 follows a moving waypoint (the
 * search orbit) rather than holding off it.
 */
export function autopilotInput(
  position: Vec3,
  yaw: number,
  target: Vec3 | null,
  options: AutopilotOptions = {},
): FlightInput {
  if (target === null) {
    return { pitch: 0, roll: 0, yaw: 0, throttle: HOVER_THROTTLE, forward: 0 };
  }
  const dx = target.x - position.x;
  const dz = target.z - position.z;
  const dy = target.y - position.y;
  const horizontal = Math.hypot(dx, dz);

  // Yaw: proportional, with a deadband so it never hunts across zero.
  const yawError = shortestAngle(Math.atan2(-dx, -dz) - yaw);
  const yawCommand = Math.abs(yawError) <= SCOUT_YAW_DEADBAND
    ? 0
    : Math.max(-1, Math.min(1, yawError * 2.5));

  // Vertical: proportional on the deadbanded offset, damped by climb rate.
  const dyError = Math.abs(dy) <= SCOUT_ALT_DEADBAND
    ? 0
    : dy - Math.sign(dy) * SCOUT_ALT_DEADBAND;
  const climbRate = options.velocity?.y ?? 0;
  const throttle = Math.max(
    0.25,
    Math.min(0.95, HOVER_THROTTLE + dyError * 0.02 - climbRate * 0.035),
  );

  // Horizontal: close outside the standoff, coast through the band, brake
  // inside it. Alignment keeps thrust pointed where the nose will be, not
  // where it currently is.
  const radial = horizontal - (options.standoff ?? SCOUT_HOLD_RANGE);
  let closure = 0;
  if (radial > SCOUT_ARRIVE_BAND) {
    closure = Math.min(1, (radial - SCOUT_ARRIVE_BAND) / SCOUT_CLOSE_BAND);
  } else if (radial < -SCOUT_ARRIVE_BAND) {
    closure = Math.max(-0.5, (radial + SCOUT_ARRIVE_BAND) / SCOUT_CLOSE_BAND);
  }
  const alignment = Math.max(0, Math.cos(yawError));
  return {
    pitch: 0,
    roll: 0,
    yaw: yawCommand,
    throttle,
    forward: SCOUT_MAX_FORWARD * alignment * closure,
  };
}

/** Exponential smoothing of an aim point; alpha follows the frame time. */
export function smoothAim(current: Vec3 | null, target: Vec3, dt: number): Vec3 {
  if (current === null) return { ...target };
  const alpha = 1 - Math.exp(-Math.max(0, dt) / AIM_SMOOTHING_S);
  return {
    x: current.x + (target.x - current.x) * alpha,
    y: current.y + (target.y - current.y) * alpha,
    z: current.z + (target.z - current.z) * alpha,
  };
}

/** World position a bearing/range fix implies, at a supplied altitude. */
export function trackTarget(
  from: Vec3,
  bearingDeg: number,
  range: number,
  altitude: number,
): Vec3 {
  const bearing = (bearingDeg * Math.PI) / 180;
  return {
    x: from.x + Math.sin(bearing) * range,
    y: altitude,
    z: from.z - Math.cos(bearing) * range,
  };
}

/**
 * Waypoint on the airborne search orbit at a given session time. The scout
 * radar is range-limited, so the search is about position: a slow orbit whose
 * 400-unit reach sweeps the whole contact corridor, corners included.
 */
export function patrolWaypoint(elapsedSec: number, altitude: number): Vec3 {
  const angle = (Math.PI * 2 * elapsedSec) / SCOUT_PATROL_PERIOD_S;
  return {
    x: Math.sin(angle) * SCOUT_PATROL_RADIUS,
    y: altitude,
    z: -Math.cos(angle) * SCOUT_PATROL_RADIUS,
  };
}
