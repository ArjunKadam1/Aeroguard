// Pure flight dynamics. No Three.js import, so the whole integrator is unit
// testable under vitest's node environment.
//
// This is "arcade-realistic": a rigid body with gravity, thrust along the
// aircraft's local up axis, angular rate damping and quadratic drag. It is not a
// full 6-DOF quadcopter simulation (no per-rotor thrust or PID loops) -- that
// is a later, separate step. The interface is deliberately narrow so swapping in
// a fuller integrator later would not touch the caller.

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface FlightInput {
  /** -1 nose down .. +1 nose up. Visual feedback; does not drive translation. */
  pitch: number;
  /** -1 roll left .. +1 roll right. Visual feedback only. */
  roll: number;
  /** -1 yaw left .. +1 yaw right. */
  yaw: number;
  /** 0 .. 1 collective thrust, which is what lifts and descends. */
  throttle: number;
  /** -1 reverse .. +1 forward, applied along the aircraft heading. */
  forward: number;
}

export interface FlightState {
  position: Vec3;
  velocity: Vec3;
  /** Euler attitude in radians: yaw about Y, pitch about X, roll about Z. */
  attitude: Vec3;
  /** Angular rate in radians per second. */
  angularVelocity: Vec3;
}

export interface FlightEnvironment {
  /** Ground height at a world position, from Terrain.heightAt. */
  groundAt(x: number, z: number): number;
  /** Downward acceleration in units/s^2. */
  gravity: number;
}

export const GRAVITY = 18;
export const THRUST_MAX = 34;
// Translational thrust along the heading, independent of attitude. Without this
// the only way to move is to tilt the nose, which couples travel to lift and
// makes the aircraft climb whenever it accelerates.
export const FORWARD_THRUST = 26;
export const PITCH_RATE = 1.9;
export const ROLL_RATE = 2.4;
export const YAW_RATE = 1.2;
export const ANGULAR_DAMPING = 3.2;
// Gentle auto-levelling so the aircraft settles flat but can still hold a
// visible bank or nose-down attitude while moving.
export const SELF_LEVEL_RATE = 1.6;
export const LINEAR_DRAG = 0.045;
export const MIN_ALTITUDE_CLEARANCE = 1.6;
export const MAX_SPEED = 120;

export function createFlightState(x = 0, y = 0, z = 0): FlightState {
  return {
    position: { x, y, z },
    velocity: { x: 0, y: 0, z: 0 },
    attitude: { x: 0, y: 0, z: 0 },
    angularVelocity: { x: 0, y: 0, z: 0 },
  };
}

export const NEUTRAL_INPUT: FlightInput = {
  pitch: 0, roll: 0, yaw: 0, throttle: 0, forward: 0,
};

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

function lengthOf(v: Vec3): number {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}

// Body axes from Euler attitude (yaw about Y, then pitch about X, then roll
// about Z). The aircraft starts level with -Z as forward. These are built by
// composing the three rotation matrices and applying them to the basis vectors,
// which keeps every axis exactly unit length at any attitude -- a hand-expanded
// form here silently drifts and makes pitch produce no forward motion.
//
// Sign convention: positive pitch (nose down) tilts forward (-Z) toward -Y, so
// positive throttle + positive pitch produces forward flight along -Z. Roll is
// about the forward axis.
function rotY(a: number): number[][] {
  const c = Math.cos(a); const s = Math.sin(a);
  return [[c, 0, s], [0, 1, 0], [-s, 0, c]];
}
function rotX(a: number): number[][] {
  const c = Math.cos(a); const s = Math.sin(a);
  return [[1, 0, 0], [0, c, -s], [0, s, c]];
}
function rotZ(a: number): number[][] {
  const c = Math.cos(a); const s = Math.sin(a);
  return [[c, -s, 0], [s, c, 0], [0, 0, 1]];
}
function matMul(a: number[][], b: number[][]): number[][] {
  const out = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < 3; i += 1) {
    for (let j = 0; j < 3; j += 1) {
      let sum = 0;
      for (let k = 0; k < 3; k += 1) sum += a[i][k] * b[k][j];
      out[i][j] = sum;
    }
  }
  return out;
}
function apply(m: number[][], v: Vec3): Vec3 {
  return {
    x: m[0][0] * v.x + m[0][1] * v.y + m[0][2] * v.z,
    y: m[1][0] * v.x + m[1][1] * v.y + m[1][2] * v.z,
    z: m[2][0] * v.x + m[2][1] * v.y + m[2][2] * v.z,
  };
}

function basisMatrix(attitude: Vec3): number[][] {
  // Negate pitch so that positive attitude.x means nose down. Under this
  // convention forward tilts toward -Y and the up vector tilts toward the nose,
  // which is the correct geometry for a nose-down rotation.
  return matMul(matMul(rotY(attitude.y), rotX(-attitude.x)), rotZ(attitude.z));
}

export function forwardVector(attitude: Vec3): Vec3 {
  return apply(basisMatrix(attitude), { x: 0, y: 0, z: -1 });
}

export function upVector(attitude: Vec3): Vec3 {
  return apply(basisMatrix(attitude), { x: 0, y: 1, z: 0 });
}

export function rightVector(attitude: Vec3): Vec3 {
  return apply(basisMatrix(attitude), { x: 1, y: 0, z: 0 });
}

export function clampPitch(attitude: Vec3): void {
  // ±80 degrees so the aircraft cannot be flown inverted into the ground.
  attitude.x = clamp(attitude.x, -1.396, 1.396);
}

export function clampRoll(attitude: Vec3): void {
  // Roll is clamped to ±80 degrees for the same reason as pitch.
  attitude.z = clamp(attitude.z, -1.396, 1.396);
}

export function stepFlight(
  state: FlightState,
  input: FlightInput,
  dt: number,
  env: FlightEnvironment,
): FlightState {
  // Guard against a zero or negative step, which would freeze or reverse time.
  const step = dt > 0 ? Math.min(dt, 0.1) : 0;
  if (step === 0) return state;

  const pitch = clamp(input.pitch, -1, 1);
  const roll = clamp(input.roll, -1, 1);
  const yaw = clamp(input.yaw, -1, 1);
  const throttle = clamp(input.throttle, 0, 1);
  const forward = clamp(input.forward, -1, 1);

  // --- Angular.
  // Each axis is a rate-limited servo: the commanded rate is approached, then
  // the residual decays. Releasing the stick therefore bleeds the rate back to
  // zero (self-centering), while holding it holds the commanded attitude.
  const av = state.angularVelocity;
  const approach = Math.min(1, step * 6);
  av.x += (pitch * PITCH_RATE - av.x) * approach;
  av.z += (roll * ROLL_RATE - av.z) * approach;
  av.y += (yaw * YAW_RATE - av.y) * approach;
  // Residual damping so rate decays when the stick is centred.
  av.x -= av.x * ANGULAR_DAMPING * step;
  av.y -= av.y * ANGULAR_DAMPING * step;
  av.z -= av.z * ANGULAR_DAMPING * step;

  // --- Attitude. Pitch and roll self-level (a real multirotor rights itself),
  // yaw is persistent heading. Roll and pitch decay toward level with a
  // restoring torque so the aircraft settles flat when the stick is released.
  const at = state.attitude;
  at.x += av.x * step;
  at.y += av.y * step;
  at.z += av.z * step;
  // Self-righting: gently return pitch and roll to level.
  at.x -= at.x * SELF_LEVEL_RATE * step;
  at.z -= at.z * SELF_LEVEL_RATE * step;
  clampPitch(at);
  clampRoll(at);

  // --- Linear: thrust along body up, translation along body forward, gravity
// down, then quadratic drag.
  const up = upVector(at);
  const fwd = forwardVector(at);
  const v = state.velocity;

  const thrust = THRUST_MAX * throttle;
  const push = FORWARD_THRUST * forward;
  v.x += (up.x * thrust + fwd.x * push) * step;
  v.y += (up.y * thrust + fwd.y * push - env.gravity) * step;
  v.z += (up.z * thrust + fwd.z * push) * step;

  const speed = lengthOf(v);
  if (speed > 0) {
    const drag = LINEAR_DRAG * speed;
    v.x -= v.x * drag * step;
    v.y -= v.y * drag * step;
    v.z -= v.z * drag * step;
  }

  const newSpeed = lengthOf(v);
  if (newSpeed > MAX_SPEED) {
    const scale = MAX_SPEED / newSpeed;
    v.x *= scale;
    v.y *= scale;
    v.z *= scale;
  }

  const p = state.position;
  p.x += v.x * step;
  p.y += v.y * step;
  p.z += v.z * step;

  // --- Ground collision: clamp to the terrain surface and kill downward speed.
  const ground = env.groundAt(p.x, p.z) + MIN_ALTITUDE_CLEARANCE;
  if (p.y < ground) {
    p.y = ground;
    if (v.y < 0) v.y = 0;
  }

  // --- Soft world bounds so the trainee cannot fly out into empty void.
  const bound = 1900;
  for (const axis of ["x", "z"] as const) {
    if (p[axis] > bound) { p[axis] = bound; v[axis] = -Math.abs(v[axis]) * 0.3; }
    if (p[axis] < -bound) { p[axis] = -bound; v[axis] = Math.abs(v[axis]) * 0.3; }
  }
  if (p.y > 700) { p.y = 700; v.y = -Math.abs(v.y) * 0.3; }

  return state;
}

// True when the aircraft is level and slow enough to be considered landed.
export function isLanded(state: FlightState, env: FlightEnvironment): boolean {
  return state.position.y <= env.groundAt(state.position.x, state.position.z) + MIN_ALTITUDE_CLEARANCE + 0.05
    && state.velocity.y <= 0.01
    && lengthOf(state.velocity) < 6;
}

export function speedOf(state: FlightState): number {
  return lengthOf(state.velocity);
}

export function altitudeAgl(state: FlightState, env: FlightEnvironment): number {
  return state.position.y - env.groundAt(state.position.x, state.position.z);
}