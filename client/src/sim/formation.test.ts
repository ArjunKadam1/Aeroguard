import { describe, expect, it } from "vitest";
import {
  ESCORT_COUNT,
  ESCORT_SLOTS,
  FORMATION_STEP_S,
  SWARM_LATERAL,
  SWARM_TRAIL,
  escortOffsets,
  swarmOffsetAt,
  swarmSlot,
} from "./formation";

function planarDistance(a: { x: number; z: number }, b: { x: number; z: number }): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

describe("escortOffsets", () => {
  it("returns one offset per escort slot", () => {
    expect(escortOffsets(11, "T04", 10)).toHaveLength(ESCORT_COUNT);
  });

  it("starts on the formation slots at spawn", () => {
    const offsets = escortOffsets(11, "T04", 0);
    offsets.forEach((offset, i) => {
      expect(offset.x).toBeCloseTo(ESCORT_SLOTS[i].x, 6);
      expect(offset.y).toBeCloseTo(ESCORT_SLOTS[i].y, 6);
      expect(offset.z).toBeCloseTo(ESCORT_SLOTS[i].z, 6);
    });
  });

  it("is deterministic regardless of query order", () => {
    const first = escortOffsets(11, "T04", 30);
    escortOffsets(11, "T04", 240);
    expect(escortOffsets(11, "T04", 30)).toEqual(first);
  });

  it("keeps every escort in its station-keeping box for a whole session", () => {
    for (const seed of [7, 4242]) {
      for (const id of ["T04", "T08"]) {
        for (let t = 0; t <= 180; t += 2) {
          for (const offset of escortOffsets(seed, id, t)) {
            expect(Math.abs(offset.x)).toBeLessThanOrEqual(9 + 1e-9);
            expect(Math.abs(offset.z)).toBeLessThanOrEqual(9 + 1e-9);
            expect(Math.abs(offset.y)).toBeLessThanOrEqual(2.2 + 1e-9);
          }
        }
      }
    }
  });

  it("keeps the escorts close to their slots", () => {
    for (const seed of [7, 11, 4242]) {
      for (let t = 0; t <= 180; t += 1) {
        const offsets = escortOffsets(seed, "T04", t);
        offsets.forEach((offset, i) => {
          expect(planarDistance(offset, ESCORT_SLOTS[i])).toBeLessThanOrEqual(2.5);
        });
      }
    }
  });

  it("keeps the trio apart so it never collapses to one point", () => {
    for (const seed of [7, 11, 4242]) {
      for (let t = 0; t <= 180; t += 1) {
        const offsets = escortOffsets(seed, "T04", t);
        for (const offset of offsets) {
          // Separation from the lead at the local origin.
          expect(Math.hypot(offset.x, offset.z)).toBeGreaterThan(4);
        }
        expect(planarDistance(offsets[0], offsets[1])).toBeGreaterThan(7);
      }
    }
  });

  it("wanders instead of flying a rigid formation", () => {
    const before = escortOffsets(11, "T04", 30)[0];
    const after = escortOffsets(11, "T04", 60)[0];
    expect(planarDistance(before, after)).toBeGreaterThan(0.4);
  });

  it("varies with the scenario seed and the contact id", () => {
    expect(escortOffsets(11, "T04", 30)).not.toEqual(escortOffsets(4242, "T04", 30));
    expect(escortOffsets(11, "T04", 30)).not.toEqual(escortOffsets(11, "T08", 30));
  });

  it("interpolates smoothly between fixed steps", () => {
    const a = escortOffsets(11, "T04", 30);
    const b = escortOffsets(11, "T04", 30 + FORMATION_STEP_S / 2);
    const c = escortOffsets(11, "T04", 30 + FORMATION_STEP_S);
    // A half-step sample sits between its neighbours, never jumps past one.
    expect(planarDistance(a[0], b[0])).toBeGreaterThan(0);
    expect(planarDistance(b[0], c[0])).toBeGreaterThan(0);
    expect(planarDistance(a[0], b[0])).toBeLessThan(planarDistance(a[0], c[0]) + 1e-9);
  });
});

describe("scenario-declared swarms", () => {
  it("places the lead at the origin and wingmen behind and outboard", () => {
    expect(swarmSlot(0)).toEqual({ x: 0, y: 0, z: 0 });
    expect(swarmSlot(1).x).toBe(-SWARM_TRAIL);
    expect(swarmSlot(1).z).toBe(SWARM_LATERAL);
    expect(swarmSlot(2).x).toBe(-SWARM_TRAIL);
    expect(swarmSlot(2).z).toBe(-SWARM_LATERAL);
    expect(swarmSlot(3).x).toBe(-2 * SWARM_TRAIL);
  });

  it("keeps members far enough apart to be resolved individually", () => {
    for (let t = 0; t <= 180; t += 1) {
      for (const seed of [7, 4242]) {
        for (const id of ["T01", "T02", "T03"]) {
          const one = swarmOffsetAt(seed, id, 1, t);
          const two = swarmOffsetAt(seed, id, 2, t);
          expect(planarDistance(one, two)).toBeGreaterThan(30);
          // Each wingman also stays clear of the lead at the origin.
          expect(Math.hypot(one.x, one.z)).toBeGreaterThan(20);
          expect(Math.hypot(two.x, two.z)).toBeGreaterThan(20);
        }
      }
    }
  });

  it("stays inside the loose formation envelope", () => {
    for (let t = 0; t <= 180; t += 1) {
      const offset = swarmOffsetAt(11, "T02", 3, t);
      expect(Math.abs(offset.x)).toBeLessThanOrEqual(2 * SWARM_TRAIL + 7.1);
      expect(Math.abs(offset.z)).toBeLessThanOrEqual(2 * SWARM_LATERAL + 7.1);
      expect(Math.abs(offset.y)).toBeLessThanOrEqual(3 + 2.2 + 1e-9);
    }
  });

  it("is deterministic regardless of query order", () => {
    const first = swarmOffsetAt(11, "T02", 1, 42);
    swarmOffsetAt(11, "T02", 1, 120);
    expect(swarmOffsetAt(11, "T02", 1, 42)).toEqual(first);
  });

  it("wanders instead of freezing on the slot", () => {
    const a = swarmOffsetAt(11, "T02", 1, 10);
    const b = swarmOffsetAt(11, "T02", 1, 40);
    expect(planarDistance(a, b)).toBeGreaterThan(0.5);
  });

  it("varies with the scenario seed and the contact id", () => {
    expect(swarmOffsetAt(7, "T02", 1, 30))
      .not.toEqual(swarmOffsetAt(8, "T02", 1, 30));
    expect(swarmOffsetAt(7, "T02", 1, 30))
      .not.toEqual(swarmOffsetAt(7, "T03", 1, 30));
  });
});
