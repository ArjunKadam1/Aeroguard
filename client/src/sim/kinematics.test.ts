import { describe, expect, it } from "vitest";
import {
  AIRFRAME_LIMITS,
  STEP_S,
  flownPoint,
  turnRateLimitDeg,
  type KinematicAirframe,
} from "./kinematics";
import {
  AIRSPACE_X,
  AIRSPACE_Z,
  ALT_OFFSET_MAX,
  ALT_OFFSET_MIN,
  KNOWN_PATTERNS,
  trajectoryPosition,
} from "./trajectory";

const AIRFRAMES: readonly KinematicAirframe[] = ["quad", "wing"];
const SPEEDS = [3, 6, 10] as const;

function wrapSigned(angle: number): number {
  return ((angle + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
}

function distance(a: { x: number; z: number }, b: { x: number; z: number }): number {
  return Math.hypot(b.x - a.x, b.z - a.z);
}

describe("turnRateLimitDeg", () => {
  it("is bank-limited: faster flight corners wider", () => {
    expect(turnRateLimitDeg("wing", 10)).toBeCloseTo(22.71, 1);
    expect(turnRateLimitDeg("quad", 10)).toBeCloseTo(56.21, 1);
    expect(turnRateLimitDeg("wing", 10)).toBeLessThan(turnRateLimitDeg("wing", 3));
  });

  it("caps both airframes at their structural ceiling", () => {
    expect(turnRateLimitDeg("wing", 3)).toBe(45);
    expect(turnRateLimitDeg("quad", 3)).toBe(90);
    expect(turnRateLimitDeg("quad", 0.1)).toBe(90);
  });

  it("keeps the quad twice as agile as the wing at the same speed", () => {
    for (const speed of [6, 10, 20]) {
      expect(turnRateLimitDeg("quad", speed)).toBeGreaterThan(
        turnRateLimitDeg("wing", speed) * 1.9,
      );
    }
  });
});

describe("flownPoint", () => {
  it("starts exactly on the guidance path", () => {
    for (const pattern of KNOWN_PATTERNS) {
      for (const airframe of AIRFRAMES) {
        const guide = trajectoryPosition(pattern, 0, 6, 42, "T01");
        const start = flownPoint(pattern, airframe, 6, 42, "T01", 0);
        expect(start.x).toBeCloseTo(guide.x, 6);
        expect(start.z).toBeCloseTo(guide.z, 6);
        expect(start.altOffset).toBeCloseTo(guide.altOffset, 6);
      }
    }
  });

  it("is deterministic regardless of query order", () => {
    const first = flownPoint("wide-weave", "wing", 6, 7, "T09", 5);
    flownPoint("wide-weave", "wing", 6, 7, "T09", 240);
    const again = flownPoint("wide-weave", "wing", 6, 7, "T09", 5);
    expect(again).toEqual(first);
  });

  it("keeps every pattern, class, and airframe inside the airspace box", () => {
    for (const pattern of KNOWN_PATTERNS) {
      for (const airframe of AIRFRAMES) {
        for (const speed of SPEEDS) {
          for (let t = 0; t <= 180; t += 5) {
            const p = flownPoint(pattern, airframe, speed, 11, "T02", t);
            expect(Math.abs(p.x)).toBeLessThanOrEqual(AIRSPACE_X + 0.001);
            expect(Math.abs(p.z)).toBeLessThanOrEqual(AIRSPACE_Z + 0.001);
            expect(p.altOffset).toBeGreaterThanOrEqual(ALT_OFFSET_MIN - 0.001);
            expect(p.altOffset).toBeLessThanOrEqual(ALT_OFFSET_MAX + 0.001);
          }
        }
      }
    }
  });

  it("never exceeds the current turn-rate limit", () => {
    for (const airframe of AIRFRAMES) {
      for (const pattern of ["erratic-jink", "wide-weave"] as const) {
        for (let i = 0; i < 900; i += 1) {
          const a = flownPoint(pattern, airframe, 10, 3, "T05", i * STEP_S);
          const b = flownPoint(pattern, airframe, 10, 3, "T05", (i + 1) * STEP_S);
          const limitRad = ((turnRateLimitDeg(airframe, a.speed) * Math.PI) / 180) * STEP_S;
          expect(Math.abs(wrapSigned(b.headingRad - a.headingRad)))
            .toBeLessThanOrEqual(limitRad + 1e-6);
        }
      }
    }
  });

  it("tracks the guidance closer when the airframe is more agile", () => {
    function meanDeviation(airframe: KinematicAirframe): number {
      let sum = 0;
      for (let i = 0; i <= 600; i += 1) {
        const t = i * STEP_S;
        const flown = flownPoint("wide-weave", airframe, 10, 3, "T05", t);
        const guide = trajectoryPosition("wide-weave", t, 10, 3, "T05");
        sum += distance(flown, guide);
      }
      return sum / 601;
    }
    // Measured: quad ~8u, wing ~40u over the first minute at fast cruise.
    expect(meanDeviation("quad")).toBeLessThan(meanDeviation("wing") * 0.5);
  });

  it("accelerates from launch instead of starting at cruise speed", () => {
    const quad = flownPoint("wide-weave", "quad", 6, 42, "T03", 0);
    const quadAfter = flownPoint("wide-weave", "quad", 6, 42, "T03", 1);
    const wing = flownPoint("wide-weave", "wing", 6, 42, "T03", 0);
    const wingAfter = flownPoint("wide-weave", "wing", 6, 42, "T03", 1);
    const quadDistance = distance(quad, quadAfter);
    const wingDistance = distance(wing, wingAfter);
    // First second is a launch ramp for both, but the quad spools up faster.
    expect(quadDistance).toBeGreaterThan(wingDistance);
    expect(quadDistance).toBeLessThan(6);
  });

  it("limits altitude changes to each airframe's climb rate", () => {
    for (const airframe of AIRFRAMES) {
      const limit = AIRFRAME_LIMITS[airframe].climbRate * STEP_S;
      for (let i = 0; i < 900; i += 1) {
        const a = flownPoint("altitude-step", airframe, 6, 7, "T02", i * STEP_S);
        const b = flownPoint("altitude-step", airframe, 6, 7, "T02", (i + 1) * STEP_S);
        expect(Math.abs(b.altOffset - a.altOffset)).toBeLessThanOrEqual(limit + 1e-6);
      }
    }
  });

  it("holds altitude steps better with a higher climb rate", () => {
    let quadPeak = 0;
    let wingPeak = 0;
    for (let i = 0; i <= 600; i += 1) {
      const t = i * STEP_S;
      quadPeak = Math.max(quadPeak, Math.abs(flownPoint("altitude-step", "quad", 6, 7, "T02", t).altOffset));
      wingPeak = Math.max(wingPeak, Math.abs(flownPoint("altitude-step", "wing", 6, 7, "T02", t).altOffset));
    }
    // Measured: quad ~17u, wing ~10u of the commanded step.
    expect(quadPeak).toBeGreaterThan(wingPeak);
    expect(quadPeak).toBeLessThanOrEqual(ALT_OFFSET_MAX);
  });

  it("faces along its own velocity", () => {
    const a = flownPoint("wide-weave", "quad", 6, 42, "T03", 20);
    const b = flownPoint("wide-weave", "quad", 6, 42, "T03", 20 + STEP_S);
    const direction = Math.atan2(b.z - a.z, b.x - a.x);
    expect(Math.abs(wrapSigned(direction - a.headingRad))).toBeLessThan(0.1);
  });
});
