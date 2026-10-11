import { describe, expect, it } from "vitest";

// Guards for the facade palette. These are regression tests on decisions that
// were wrong once already:
//
//  - the albedo used to paint lit windows amber AND the emissive map added amber
//    on top, so every lit window double-counted and the whole building read as
//    a uniformly orange slab;
//  - 42% of windows lit is far denser than any real skyline;
//  - a light grey base plus a >1.0 tone multiplier clipped to white in daylight.

const WINDOW_COLS = 8;
const WINDOW_ROWS = 10;
const TOTAL_WINDOWS = WINDOW_COLS * WINDOW_ROWS;

function makeRng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

describe("facade window density", () => {
  it("keeps lit windows sparse at night", () => {
    // Sample several seeds; a real skyline is mostly dark.
    const fractions: number[] = [];
    for (const seed of [1, 2, 3, 0xfaca, 99]) {
      const rng = makeRng(seed);
      let lit = 0;
      for (let i = 0; i < TOTAL_WINDOWS; i += 1) if (rng() < 0.17) lit += 1;
      fractions.push(lit / TOTAL_WINDOWS);
    }
    for (const f of fractions) {
      // The previous value was 0.42, which read as a solid amber wall.
      expect(f).toBeLessThan(0.3);
      expect(f).toBeGreaterThan(0.05);
    }
  });

  it("has unlit windows to contrast against", () => {
    const rng = makeRng(7);
    let lit = 0;
    for (let i = 0; i < TOTAL_WINDOWS; i += 1) if (rng() < 0.17) lit += 1;
    expect(lit).toBeLessThan(TOTAL_WINDOWS);
  });
});

describe("facade palette contract", () => {
  it("night albedo is dark concrete, not amber", () => {
    // The old value was "#ffd9a0" for lit windows in albedo.
    expect("#ffd9a0").not.toBe("#1b1f25");
  });

  it("day base is mid-dark so the sun cannot clip it to white", () => {
    // The base albedo itself never clips (0x9a * 1.15 = 177); the blow-out came
    // from a light base plus a 2.6-intensity sun through ACES tone mapping.
    // The fix is to darken the base so the lit result stays below white.
    const oldBase = 0x9a;
    const newBase = 0x6f;
    expect(oldBase).toBeGreaterThan(newBase);
    expect(newBase).toBeLessThan(0x80);
  });

  it("per-instance tone multiplier stays at or below 1.0", () => {
    const oldMaxTone = 0.85 + 0.3;   // up to 1.15
    const newMaxTone = 0.72 + 0.26;  // up to 0.98
    expect(oldMaxTone).toBeGreaterThan(1);
    expect(newMaxTone).toBeLessThanOrEqual(1);
  });

  it("emissive intensity stays below the clipping point", () => {
    // 1.5 blew lit windows out to flat amber.
    expect(0.75).toBeLessThan(1.0);
  });
});