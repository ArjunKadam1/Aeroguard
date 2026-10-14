import { describe, expect, it } from "vitest";
import {
  ANGULAR_DAMPING,
  altitudeAgl,
  createFlightState,
  forwardVector,
  isLanded,
  speedOf,
  stepFlight,
  upVector,
  type FlightEnvironment,
  type FlightInput,
} from "./flight";
import { Terrain } from "./terrain";

const flatGround = (): FlightEnvironment => ({
  groundAt: () => 0,
  gravity: 18,
});

const terrainGround = (): FlightEnvironment => {
  const t = new Terrain({ seed: 5, environment: "rural" });
  return { groundAt: (x, z) => t.heightAt(x, z), gravity: 18 };
};

function input(over: Partial<FlightInput> = {}): FlightInput {
  return { pitch: 0, roll: 0, yaw: 0, throttle: 0, forward: 0, ...over };
}

function run(state: ReturnType<typeof createFlightState>, i: FlightInput, seconds: number, env = flatGround(), dt = 1 / 60) {
  const steps = Math.round(seconds / dt);
  for (let s = 0; s < steps; s += 1) stepFlight(state, i, dt, env);
  return state;
}

describe("flight dynamics", () => {
  it("falls under gravity when there is no thrust", () => {
    const s = createFlightState(0, 200, 0);
    run(s, input(), 1, flatGround());
    expect(s.velocity.y).toBeLessThan(0);
    expect(s.position.y).toBeLessThan(200);
  });

  it("holds altitude near neutral attitude with matching throttle", () => {
    const env = flatGround();
    const s = createFlightState(0, 200, 0);
    const startY = s.position.y;
    // Neutral attitude is level, so thrust must equal gravity to hover.
    run(s, input({ throttle: 0.53 }), 4, env);
    expect(Math.abs(s.position.y - startY)).toBeLessThan(25);
  });

  it("climbs with more throttle than hover and descends with less", () => {
    const climb = createFlightState(0, 200, 0);
    run(climb, input({ throttle: 0.9 }), 3);
    const dive = createFlightState(0, 200, 0);
    run(dive, input({ throttle: 0.2 }), 3);
    expect(climb.position.y).toBeGreaterThan(200);
    expect(dive.position.y).toBeLessThan(200);
  });

  it("pitches the nose down on forward stick and moves forward", () => {
    const s = createFlightState(0, 300, 0);
    const startZ = s.position.z;
    run(s, input({ pitch: 1, throttle: 0.6 }), 3);
    expect(s.attitude.x).toBeGreaterThan(0.1);
    // Forward is -Z, so z must decrease.
    expect(s.position.z).toBeLessThan(startZ);
  });

  // --- Translational movement (decoupled from attitude) -------------------

  it("moves forward along the heading without any tilt", () => {
    const s = createFlightState(0, 300, 0);
    run(s, input({ forward: 1, throttle: 0.53 }), 3);
    // Heading is unchanged (still -Z) so z must decrease.
    expect(s.position.z).toBeLessThan(-5);
    expect(s.attitude.x).toBeCloseTo(0, 2);
  });

  it("moves backward on reverse input", () => {
    const s = createFlightState(0, 300, 0);
    run(s, input({ forward: -1, throttle: 0.53 }), 3);
    expect(s.position.z).toBeGreaterThan(5);
  });

  it("translates along the yawed heading, not always -Z", () => {
    const s = createFlightState(0, 300, 0);
    // Hold yaw long enough to turn the aircraft off the -Z heading.
    run(s, input({ yaw: 1, throttle: 0.53 }), 2);
    expect(Math.abs(s.attitude.y)).toBeGreaterThan(0.2);
    // Turning right (+yaw) swings the heading toward -X, so forward thrust
    // must now drive -X instead of purely -Z.
    const startX = s.position.x;
    run(s, input({ forward: 1, throttle: 0.53 }), 3);
    expect(s.position.x).toBeLessThan(startX - 2);
  });

  it("reaches a usable forward speed", () => {
    const s = createFlightState(0, 300, 0);
    run(s, input({ forward: 1, throttle: 0.53 }), 8);
    expect(speedOf(s)).toBeGreaterThan(20);
    expect(speedOf(s)).toBeLessThanOrEqual(120 + 1e-6);
  });

  it("does not climb or sink while flying level forward", () => {
    const s = createFlightState(0, 300, 0);
    const startY = s.position.y;
    run(s, input({ forward: 1, throttle: 0.529 }), 5);
    // Level attitude means forward thrust is horizontal, so altitude holds.
    expect(Math.abs(s.position.y - startY)).toBeLessThan(12);
  });

  it("reaches a steeper sustained tilt than before self-levelling was relaxed", () => {
    const s = createFlightState(0, 400, 0);
    run(s, input({ pitch: 1 }), 4);
    expect(Math.abs(s.attitude.x)).toBeGreaterThan(0.6);
  });

  it("turns on yaw input", () => {
    const s = createFlightState(0, 300, 0);
    run(s, input({ yaw: 1, throttle: 0.5 }), 2);
    expect(Math.abs(s.attitude.y)).toBeGreaterThan(0.05);
  });

  it("rolls and returns toward level when input is released (damping)", () => {
    const s = createFlightState(0, 300, 0);
    run(s, input({ roll: 1 }), 1);
    const rolled = Math.abs(s.attitude.z);
    expect(rolled).toBeGreaterThan(0.2);
    run(s, input(), 4);
    // Damping pulls roll back toward level; it need not be a full return to zero.
    expect(Math.abs(s.attitude.z)).toBeLessThan(rolled * 0.5);
  });

  it("never pitches past the inverted limit", () => {
    const s = createFlightState(0, 300, 0);
    run(s, input({ pitch: 1 }), 6);
    expect(Math.abs(s.attitude.x)).toBeLessThanOrEqual(1.396 + 1e-6);
  });

  it("clamps to terrain height and stops downward motion on contact", () => {
    const env = terrainGround();
    const s = createFlightState(0, 2, 0);
    run(s, input(), 6, env);
    const ground = env.groundAt(s.position.x, s.position.z);
    expect(s.position.y).toBeGreaterThanOrEqual(ground);
    expect(s.velocity.y).toBeGreaterThanOrEqual(0);
    expect(isLanded(s, env)).toBe(true);
  });

  it("keeps the aircraft above varied terrain while cruising", () => {
    const env = terrainGround();
    const s = createFlightState(0, 300, 0);
    run(s, input({ pitch: 0.2, throttle: 0.55 }), 6, env);
    expect(altitudeAgl(s, env)).toBeGreaterThan(0);
  });

  it("is deterministic for the same inputs", () => {
    const a = createFlightState(0, 200, 0);
    const b = createFlightState(0, 200, 0);
    run(a, input({ pitch: 0.4, roll: 0.2, throttle: 0.6 }), 2);
    run(b, input({ pitch: 0.4, roll: 0.2, throttle: 0.6 }), 2);
    expect(a.position).toEqual(b.position);
    expect(a.attitude).toEqual(b.attitude);
  });

  it("ignores a non-positive time step instead of exploding", () => {
    const s = createFlightState(0, 200, 0);
    const before = { ...s.position };
    stepFlight(s, input({ throttle: 1 }), 0, flatGround());
    stepFlight(s, input({ throttle: 1 }), -1, flatGround());
    expect(s.position).toEqual(before);
  });

  it("stays within the world bounds", () => {
    const s = createFlightState(0, 400, 0);
    run(s, input({ pitch: 1, forward: 1, throttle: 1 }), 60);
    expect(Math.abs(s.position.x)).toBeLessThanOrEqual(1900);
    expect(Math.abs(s.position.z)).toBeLessThanOrEqual(1900);
    expect(s.position.y).toBeLessThanOrEqual(700);
  });

  it("caps speed under full throttle", () => {
    const s = createFlightState(0, 400, 0);
    run(s, input({ pitch: 1, throttle: 1 }), 20);
    expect(speedOf(s)).toBeLessThanOrEqual(120 + 1e-6);
  });

  it("clamps out-of-range control inputs instead of trusting them", () => {
    const s = createFlightState(0, 300, 0);
    run(s, input({ pitch: 99, roll: -99, throttle: 99, forward: 99 }), 2);
    expect(s.attitude.x).toBeLessThanOrEqual(1.396 + 1e-6);
    expect(speedOf(s)).toBeLessThanOrEqual(120 + 1e-6);
  });
});

describe("attitude vectors", () => {
  it("starts level, forward along -Z and up along +Y", () => {
    const zero = { x: 0, y: 0, z: 0 };
    const f = forwardVector(zero);
    const u = upVector(zero);
    // Compare components to avoid the -0 vs +0 trap in deep equality.
    expect(f.x).toBeCloseTo(0, 9);
    expect(f.y).toBeCloseTo(0, 9);
    expect(f.z).toBeCloseTo(-1, 9);
    expect(u.x).toBeCloseTo(0, 9);
    expect(u.y).toBeCloseTo(1, 9);
    expect(u.z).toBeCloseTo(0, 9);
  });

  it("produces unit-length basis vectors at an arbitrary attitude", () => {
    const a = { x: 0.3, y: 0.7, z: -0.2 };
    for (const v of [forwardVector(a), upVector(a)]) {
      expect(Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z)).toBeCloseTo(1, 6);
    }
  });

  it("tilts the forward vector down when the nose pitches down", () => {
    const pitched = { x: 0.5, y: 0, z: 0 };
    // Positive pitch = nose down, so forward gains a negative y component.
    expect(forwardVector(pitched).y).toBeLessThan(-0.2);
    // The up vector tips toward the nose, staying orthogonal to it.
    const dot = forwardVector(pitched).x * upVector(pitched).x
      + forwardVector(pitched).y * upVector(pitched).y
      + forwardVector(pitched).z * upVector(pitched).z;
    expect(dot).toBeCloseTo(0, 6);
  });
});

describe("scout sensor look direction", () => {
  it("derives from flight attitude alone, with no camera input", () => {
    // The V0 contract: scout sensing reads forwardVector(attitude), so the
    // same attitude always yields the same look direction no matter how any
    // display camera is oriented. forwardVector takes only an attitude.
    expect(forwardVector.length).toBe(1);
    const a = { x: 0.2, y: 1.1, z: -0.3 };
    const first = forwardVector(a);
    const second = forwardVector({ x: 0.2, y: 1.1, z: -0.3 });
    expect(second.x).toBeCloseTo(first.x, 9);
    expect(second.y).toBeCloseTo(first.y, 9);
    expect(second.z).toBeCloseTo(first.z, 9);
  });

  it("stays a stable unit vector through aggressive flight", () => {
    const s = createFlightState(0, 300, 0);
    run(s, input({ pitch: 1, roll: 1, yaw: 1, throttle: 0.7 }), 4);
    const f = forwardVector(s.attitude);
    expect(Math.sqrt(f.x * f.x + f.y * f.y + f.z * f.z)).toBeCloseTo(1, 6);
    // Nose-down pitch held against self-levelling must tilt the look down.
    expect(s.attitude.x).toBeGreaterThan(0.1);
    expect(f.y).toBeLessThan(0);
  });

  it("swings with yaw so the sensor follows the heading", () => {
    const s = createFlightState(0, 300, 0);
    run(s, input({ yaw: 1, throttle: 0.53 }), 2);
    expect(Math.abs(s.attitude.y)).toBeGreaterThan(0.2);
    const f = forwardVector(s.attitude);
    // Turning right (+yaw) swings forward from -Z toward -X.
    expect(f.x).toBeLessThan(-0.1);
    expect(f.z).toBeLessThan(0);
  });
});

describe("constants", () => {
  it("keeps damping positive so rotation decays", () => {
    expect(ANGULAR_DAMPING).toBeGreaterThan(0);
  });
});