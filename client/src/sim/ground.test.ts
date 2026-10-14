import { describe, expect, it } from "vitest";
import {
  STREET_BLOCK,
  isSidewalk,
  isStreetLine,
  sampleGround,
} from "./ground";

describe("isStreetLine", () => {
  it("runs on cell boundaries, not through building cells", () => {
    // Building cells centre on multiples of 90; streets sit between them.
    expect(isStreetLine(45)).toBe(true);
    expect(isStreetLine(135)).toBe(true);
    expect(isStreetLine(-45)).toBe(true);
    expect(isStreetLine(0)).toBe(false);
    expect(isStreetLine(90)).toBe(false);
    expect(isStreetLine(-90)).toBe(false);
  });

  it("repeats every block", () => {
    expect(isStreetLine(45 + STREET_BLOCK * 3)).toBe(true);
    expect(isStreetLine(45 - STREET_BLOCK * 5)).toBe(true);
  });

  it("has a bounded half-width", () => {
    expect(isStreetLine(45 + 6.9)).toBe(true);
    expect(isStreetLine(45 + 7.1)).toBe(false);
  });
});

describe("isSidewalk", () => {
  it("rings the streets without overlapping them", () => {
    expect(isSidewalk(45)).toBe(false); // the street itself
    expect(isSidewalk(45 + 8)).toBe(true);
    expect(isSidewalk(45 + 11)).toBe(false); // plain block
    expect(isSidewalk(0)).toBe(false);
  });
});

describe("sampleGround", () => {
  it("is deterministic per seed and position", () => {
    expect(sampleGround(10, 20, "urban", 7)).toEqual(sampleGround(10, 20, "urban", 7));
    expect(sampleGround(10, 20, "urban", 7)).not.toEqual(sampleGround(10, 20, "urban", 8));
  });

  it("paints dark asphalt on streets and lighter blocks", () => {
    const [sr, sg, sb] = sampleGround(45, 0, "urban", 7);
    const [br, bg, bb] = sampleGround(0, 0, "urban", 7);
    expect(sr + sg + sb).toBeLessThan(br + bg + bb);
    expect(sr).toBeLessThan(70);
  });

  it("paints a dirt road through rural grass", () => {
    const [rr, rg, rb] = sampleGround(100, 0, "rural", 7);
    const [gr, gg, gb] = sampleGround(100, 200, "rural", 7);
    // Dirt is browner (red above green); grass is greener.
    expect(rr - rg).toBeGreaterThan(gr - gg);
    expect([rr, rg, rb, gr, gg, gb].every((v) => v >= 0 && v <= 255)).toBe(true);
  });

  it("varies rural grass across blotch cells", () => {
    const a = sampleGround(0, 200, "rural", 7);
    const b = sampleGround(500, 600, "rural", 7);
    expect(a).not.toEqual(b);
  });

  it("keeps every channel in byte range", () => {
    for (const [x, z, env] of [[-999, -999, "urban"], [999, 999, "rural"], [0, 0, "urban"]] as const) {
      for (const v of sampleGround(x, z, env, 3)) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(255);
      }
    }
  });
});
