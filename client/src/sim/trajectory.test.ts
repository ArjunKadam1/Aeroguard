import { describe, expect, it } from "vitest";
import {
  AIRSPACE_X,
  AIRSPACE_Z,
  ALT_OFFSET_MAX,
  ALT_OFFSET_MIN,
  CORRIDOR_MAX_X,
  CORRIDOR_MIN_X,
  KNOWN_PATTERNS,
  corridorParams,
  deriveParams,
  hashString,
  resolvePattern,
  trajectoryPosition,
} from "./trajectory";
import type { FlightPattern } from "../api/types";

const SEEDS = [11, 4242, 777001];
const IDS = ["T01", "T02", "T03"];
const SPEEDS = [3, 6, 10];

// Pre-refactor corridor anchors for T01 (medium, 6 u/s), unchanged by T1:
// hashString("T01") = 82261, row 0, phase 0.70, x = -46 at t = 10s.
describe("straight-transit corridor parity", () => {
  it("hashes ids exactly as the corridor always has", () => {
    expect(hashString("T01")).toBe(82261);
    expect(corridorParams("T01")).toEqual({ row: 0, phase: 0.7 });
  });

  it("reproduces the corridor position for T01 at t=10s", () => {
    const point = trajectoryPosition("straight-transit", 10, 6, 999, "T01");
    expect(point.x).toBeCloseTo(-46, 9);
    expect(point.z).toBe(0);
    expect(point.altOffset).toBe(0);
  });

  it("ignores the seed on the corridor path", () => {
    const a = trajectoryPosition("straight-transit", 37.5, 10, 11, "T02");
    const b = trajectoryPosition("straight-transit", 37.5, 10, 4242, "T02");
    expect(a).toEqual(b);
  });

  it("stays inside the corridor band at every speed", () => {
    for (const speed of SPEEDS) {
      for (let t = 0; t < 200; t += 2.5) {
        const { x } = trajectoryPosition("straight-transit", t, speed, 11, "T03");
        expect(x).toBeGreaterThanOrEqual(CORRIDOR_MIN_X);
        expect(x).toBeLessThan(CORRIDOR_MAX_X);
      }
    }
  });
});

describe("wide-airspace bounds", () => {
  it("keeps every pattern inside the box with altitude in band", () => {
    for (const pattern of KNOWN_PATTERNS) {
      if (pattern === "straight-transit") continue;
      for (const seed of SEEDS) {
        for (const id of IDS) {
          for (const speed of SPEEDS) {
            for (let t = 0; t <= 200; t += 2) {
              const p = trajectoryPosition(pattern, t, speed, seed, id);
              expect(Math.abs(p.x)).toBeLessThanOrEqual(AIRSPACE_X);
              expect(Math.abs(p.z)).toBeLessThanOrEqual(AIRSPACE_Z);
              expect(p.altOffset).toBeGreaterThanOrEqual(ALT_OFFSET_MIN);
              expect(p.altOffset).toBeLessThanOrEqual(ALT_OFFSET_MAX);
            }
          }
        }
      }
    }
  });
});

describe("determinism and seed sensitivity", () => {
  it("returns bit-identical positions for identical inputs", () => {
    for (const pattern of KNOWN_PATTERNS) {
      const a = trajectoryPosition(pattern, 63.25, 6, 4242, "T02");
      const b = trajectoryPosition(pattern, 63.25, 6, 4242, "T02");
      expect(a).toEqual(b);
    }
  });

  it("derives distinct parameters per seed", () => {
    // Same contact, different scenarios: the sky must not repeat itself.
    let diverged = 0;
    for (const pattern of KNOWN_PATTERNS) {
      if (pattern === "straight-transit") continue;
      const a = deriveParams(11, "T01", pattern);
      const b = deriveParams(4242, "T01", pattern);
      if (JSON.stringify(a) !== JSON.stringify(b)) diverged += 1;
    }
    expect(diverged).toBe(KNOWN_PATTERNS.length - 1);
  });

  it("moves identical contacts apart across seeds", () => {
    const a = trajectoryPosition("wide-weave", 60, 6, 11, "T01");
    const b = trajectoryPosition("wide-weave", 60, 6, 4242, "T01");
    const dist = Math.hypot(a.x - b.x, a.z - b.z);
    expect(dist).toBeGreaterThan(10);
  });
});

describe("pattern distinctness", () => {
  function dist3(
    a: { x: number; z: number; altOffset: number },
    b: { x: number; z: number; altOffset: number },
  ): number {
    return Math.sqrt(
      (a.x - b.x) * (a.x - b.x) + (a.z - b.z) * (a.z - b.z)
        + (a.altOffset - b.altOffset) * (a.altOffset - b.altOffset),
    );
  }

  it("separates every pattern pair over a session window", () => {
    // Patterns must be distinguishable over time, not at every instant.
    const times = [20, 40, 60, 90, 120];
    for (let i = 0; i < KNOWN_PATTERNS.length; i += 1) {
      for (let j = i + 1; j < KNOWN_PATTERNS.length; j += 1) {
        const a = KNOWN_PATTERNS[i];
        const b = KNOWN_PATTERNS[j];
        let best = 0;
        for (const t of times) {
          const pa = trajectoryPosition(a, t, 6, 4242, "T02");
          const pb = trajectoryPosition(b, t, 6, 4242, "T02");
          best = Math.max(best, dist3(pa, pb));
        }
        expect(best).toBeGreaterThan(30);
      }
    }
  });
});

describe("continuity", () => {
  it("never teleports between ticks on any pattern", () => {
    // 0.25s sampling, 12u ceiling: generous for fast maneuvers, a tripwire
    // for discontinuities (branch jumps, bad bounces). Straight transit is
    // excluded: its lap wrap (50 -> -70) is legacy-tested corridor behavior,
    // not a defect the new patterns may copy.
    for (const pattern of KNOWN_PATTERNS) {
      if (pattern === "straight-transit") continue;
      let prev = trajectoryPosition(pattern, 0, 10, 11, "T01");
      for (let t = 0.25; t <= 200; t += 0.25) {
        const next = trajectoryPosition(pattern, t, 10, 11, "T01");
        const step = Math.hypot(next.x - prev.x, next.z - prev.z);
        expect(step).toBeLessThanOrEqual(12);
        prev = next;
      }
    }
  });

  it("closes the orbit-hold loop", () => {
    // Ellipse around a hold point: returning to the same phase returns to
    // the same point. Period from the seeded rate at medium speed.
    const a = trajectoryPosition("orbit-hold", 5, 6, 4242, "T01");
    const period = (2 * Math.PI * 150) / 6;
    const b = trajectoryPosition("orbit-hold", 5 + period, 6, 4242, "T01");
    expect(Math.hypot(b.x - a.x, b.z - a.z)).toBeLessThan(1);
  });
});

describe("resolvePattern", () => {
  it("passes every known pattern through", () => {
    expect(KNOWN_PATTERNS).toHaveLength(7);
    for (const pattern of KNOWN_PATTERNS) {
      expect(resolvePattern(pattern)).toBe(pattern);
    }
  });

  it("falls back to straight transit for missing or unknown patterns", () => {
    expect(resolvePattern(null)).toBe("straight-transit");
    expect(resolvePattern(undefined)).toBe("straight-transit");
    expect(resolvePattern("warp-drive")).toBe("straight-transit");
    expect(resolvePattern("")).toBe("straight-transit");
  });

  it("treats fallback identically to corridor motion", () => {
    const a = trajectoryPosition("warp-drive" as FlightPattern, 10, 6, 11, "T01");
    expect(a.x).toBeCloseTo(-46, 9);
    expect(a.z).toBe(0);
  });
});
