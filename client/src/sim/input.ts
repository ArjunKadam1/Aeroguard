// Keyboard -> FlightInput mapping. Kept separate from the physics so control
// feel can be tuned without touching the integrator, and so the key map is
// testable without a DOM.

import type { FlightInput } from "./flight";

export type ControlAction =
  | "pitchUp" | "pitchDown" | "rollLeft" | "rollRight"
  | "yawLeft" | "yawRight" | "throttleUp" | "throttleDown" | "boost";

export const KEY_MAP: Readonly<Record<string, ControlAction>> = {
  // Arrow keys mirror a standard flight-sim stick.
  ArrowUp: "pitchDown",
  ArrowDown: "pitchUp",
  ArrowLeft: "rollLeft",
  ArrowRight: "rollRight",
  // WASD for yaw + throttle; Q/E also yaw for keyboard-only pilots.
  a: "yawLeft",
  d: "yawRight",
  q: "yawLeft",
  e: "yawRight",
  w: "throttleUp",
  s: "throttleDown",
  Shift: "boost",
};

// Throttle is a held position, not a rate, so it needs its own accumulator.
export interface ControlState {
  throttle: number;
  held: Set<ControlAction>;
}

export const MIN_THROTTLE = 0;
export const MAX_THROTTLE = 1;
export const THROTTLE_RATE = 0.55;
export const BOOST_THROTTLE = 0.95;

export function createControlState(initialThrottle = 0.55): ControlState {
  return { throttle: initialThrottle, held: new Set<ControlAction>() };
}

// Single-key modifiers and named keys are matched verbatim; single characters
// are matched case-insensitively so Caps Lock or a held Shift does not break
// WASD. Shift itself is multi-character, so it is unaffected by the lowercase.
export function actionForKey(key: string): ControlAction | undefined {
  if (Object.prototype.hasOwnProperty.call(KEY_MAP, key)) return KEY_MAP[key];
  if (key.length === 1) {
    const lower = key.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(KEY_MAP, lower)) return KEY_MAP[lower];
  }
  return undefined;
}

export function press(state: ControlState, key: string): void {
  const action = actionForKey(key);
  if (action) state.held.add(action);
}

export function release(state: ControlState, key: string): void {
  const action = actionForKey(key);
  if (action) state.held.delete(action);
}

export function clearControls(state: ControlState): void {
  state.held.clear();
}

// True when the key is a flight control, so the caller can suppress default
// browser behaviour (e.g. Shift activating menus, arrows scrolling).
export function isFlightKey(key: string): boolean {
  return actionForKey(key) !== undefined;
}

// Advance the held throttle and resolve the axes into a FlightInput.
export function readControls(state: ControlState, dt: number): FlightInput {
  const step = dt > 0 ? dt : 0;
  if (state.held.has("throttleUp")) {
    state.throttle = Math.min(MAX_THROTTLE, state.throttle + THROTTLE_RATE * step);
  }
  if (state.held.has("throttleDown")) {
    state.throttle = Math.max(MIN_THROTTLE, state.throttle - THROTTLE_RATE * step);
  }
  const axis = (positive: ControlAction, negative: ControlAction): number => {
    const p = state.held.has(positive) ? 1 : 0;
    const n = state.held.has(negative) ? 1 : 0;
    return p - n;
  };
  const boosting = state.held.has("boost");
  return {
    pitch: axis("pitchDown", "pitchUp"),
    roll: axis("rollRight", "rollLeft"),
    yaw: axis("yawRight", "yawLeft"),
    throttle: boosting ? Math.max(state.throttle, BOOST_THROTTLE) : state.throttle,
  };
}

// Human-readable control help, shown in the HUD.
export const CONTROL_HELP: ReadonlyArray<[string, string]> = [
  ["W / S", "throttle up / down"],
  ["Arrows", "pitch and roll"],
  ["A / D", "yaw left / right"],
  ["Shift", "boost"],
  ["C", "cycle camera"],
  ["R", "respawn"],
];