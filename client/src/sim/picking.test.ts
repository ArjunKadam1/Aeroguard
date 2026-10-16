import { describe, expect, it } from "vitest";
import {
  PICK_TOLERANCE_PX,
  advanceStationHeading,
  isMiss,
  pickContact,
  type ScreenContact,
} from "./picking";

function contact(id: string, x: number, y: number, visible = true): ScreenContact {
  return { id, x, y, visible };
}

describe("pickContact", () => {
  it("selects a contact under the cursor", () => {
    expect(pickContact([contact("T01", 100, 100)], 101, 101)).toBe("T01");
  });

  it("selects the nearest contact when several are close", () => {
    const contacts = [contact("T01", 100, 100), contact("T02", 108, 104)];
    expect(pickContact(contacts, 105, 105)).toBe("T02");
  });

  it("returns null on a genuine miss rather than snapping to the nearest", () => {
    expect(pickContact([contact("T01", 100, 100)], 600, 400)).toBeNull();
  });

  it("tolerates a near miss so a small distant contact is still hittable", () => {
    // Contacts render around 20px from the station, so exact-pixel picking
    // would be unusable.
    const target = contact("T01", 100, 100);
    expect(pickContact([target], 100 + PICK_TOLERANCE_PX - 1, 100)).toBe("T01");
    expect(pickContact([target], 100 + PICK_TOLERANCE_PX + 5, 100)).toBeNull();
  });

  it("ignores contacts that are not yet on screen", () => {
    expect(pickContact([contact("T01", 100, 100, false)], 100, 100)).toBeNull();
  });

  it("ignores contacts behind the camera or off-screen", () => {
    expect(pickContact([contact("T01", Number.NaN, 100)], 100, 100)).toBeNull();
  });

  it("picks a visible contact over a nearer invisible one", () => {
    // The invisible one is closer to the cursor but must be ignored; the
    // visible one is still within tolerance.
    const contacts = [contact("T01", 103, 100, false), contact("T02", 120, 100)];
    expect(pickContact(contacts, 100, 100)).toBe("T02");
  });

  it("returns null with no contacts at all", () => {
    expect(pickContact([], 10, 10)).toBeNull();
  });

  it("honours a custom tolerance", () => {
    const contacts = [contact("T01", 100, 100)];
    expect(pickContact(contacts, 130, 100, 5)).toBeNull();
    expect(pickContact(contacts, 104, 100, 5)).toBe("T01");
  });
});

describe("isMiss", () => {
  it("reports a miss when the click lands on empty sky", () => {
    expect(isMiss([contact("T01", 100, 100)], 500, 500)).toBe(true);
    expect(isMiss([contact("T01", 100, 100)], 100, 100)).toBe(false);
  });
});

describe("advanceStationHeading", () => {
  it("holds still when the sweep key is not held", () => {
    expect(advanceStationHeading(0.3, false, 0.016)).toBe(0.3);
  });

  it("pans only while sweeping", () => {
    expect(advanceStationHeading(0.3, true, 0.016)).toBeLessThan(0.3);
  });

  it("stays put on a non-positive time step", () => {
    expect(advanceStationHeading(0.3, true, 0)).toBe(0.3);
    expect(advanceStationHeading(0.3, true, -1)).toBe(0.3);
  });

  it("wraps around the full circle instead of stopping at a sector edge", () => {
    let heading = 0;
    for (let i = 0; i < 2000; i += 1) heading = advanceStationHeading(heading, true, 0.05);
    // 2000 × 0.05s × 0.55 ≈ 55 rad ≈ 8.75 turns: must have wrapped, and the
    // result stays a valid heading.
    expect(heading).toBeGreaterThanOrEqual(0);
    expect(heading).toBeLessThan(Math.PI * 2);
  });

  it("sweeps the reverse direction on Shift+S", () => {
    const forward = advanceStationHeading(1, true, 0.05, -1);
    const reverse = advanceStationHeading(1, true, 0.05, 1);
    expect(reverse).toBeGreaterThan(1);
    expect(forward).toBeLessThan(1);
    // Opposite directions cancel out over the same step.
    const roundTrip = advanceStationHeading(advanceStationHeading(2, true, 0.05, -1), true, 0.05, 1);
    expect(roundTrip).toBeCloseTo(2, 9);
  });

  it("wraps past north instead of clamping", () => {
    // Just below 0 heading backwards must wrap to just below 2π.
    const wrapped = advanceStationHeading(0.01, true, 0.05, -1);
    expect(wrapped).toBeGreaterThan(Math.PI * 2 - 0.1);
  });
});