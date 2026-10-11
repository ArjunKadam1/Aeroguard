import { describe, expect, it } from "vitest";
import {
  MAX_TERRAIN_HEIGHT,
  SPAWN_CLEAR_RADIUS,
  TERRAIN_SIZE,
  Terrain,
} from "./terrain";

describe("Terrain", () => {
  it("is deterministic for the same seed", () => {
    const a = new Terrain({ seed: 42, environment: "rural" });
    const b = new Terrain({ seed: 42, environment: "rural" });
    for (let i = 0; i < 50; i += 1) {
      const x = i * 37 - 400;
      const z = i * 61 - 500;
      expect(a.heightAt(x, z)).toBe(b.heightAt(x, z));
    }
  });

  it("differs between seeds (worlds are not all identical)", () => {
    const a = new Terrain({ seed: 1, environment: "rural" });
    const b = new Terrain({ seed: 2, environment: "rural" });
    const samples = [0, 100, 250, 400].map((v) => a.heightAt(v, v));
    const others = [0, 100, 250, 400].map((v) => b.heightAt(v, v));
    expect(samples.some((h, i) => Math.abs(h - others[i]) > 1)).toBe(true);
  });

  it("keeps the spawn pad flat and ramps smoothly outward", () => {
    const t = new Terrain({ seed: 7, environment: "rural" });
    expect(t.heightAt(0, 0)).toBeCloseTo(0, 6);

    // Level under the aircraft: nothing rises more than ~0.5u in the first 10.
    expect(t.heightAt(10, 0)).toBeLessThan(1);
    // Monotonically rising outward so there is no step at the pad edge.
    let previous = -1;
    for (const r of [10, 20, 30, 40, 50, 60, 80, 100, 160]) {
      const h = t.heightAt(r, 0);
      expect(h).toBeGreaterThan(previous);
      previous = h;
    }
  });

  it("stays within the height bound everywhere on the map", () => {
    const t = new Terrain({ seed: 99, environment: "urban" });
    for (let i = -TERRAIN_SIZE / 2; i < TERRAIN_SIZE / 2; i += 50) {
      const h = t.heightAt(i, i);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThanOrEqual(MAX_TERRAIN_HEIGHT);
    }
  });

  it("flattens toward the map edge so terrain meets the horizon", () => {
    const t = new Terrain({ seed: 5, environment: "rural" });
    const edge = TERRAIN_SIZE / 2 - 5;
    expect(t.heightAt(edge, 0)).toBeLessThan(MAX_TERRAIN_HEIGHT * 0.05);
  });

  it("produces rolling rural terrain and flatter urban terrain", () => {
    const rural = new Terrain({ seed: 3, environment: "rural" });
    const urban = new Terrain({ seed: 3, environment: "urban" });
    const sample = (t: Terrain) => {
      let max = 0;
      for (let i = 0; i < 40; i += 1) {
        const x = 100 + i * 40;
        max = Math.max(max, t.heightAt(x, -x));
      }
      return max;
    };
    expect(sample(rural)).toBeGreaterThan(sample(urban));
  });

  it("reports slope that is flat at the pad and non-zero on open ground", () => {
    const t = new Terrain({ seed: 11, environment: "rural" });
    expect(t.slopeAt(0, 0)).toBeCloseTo(0, 3);
    expect(t.slopeAt(600, 600)).toBeGreaterThan(0);
  });

  it("keeps the spawn radius clear of tall terrain", () => {
    const t = new Terrain({ seed: 21, environment: "rural" });
    for (let i = 0; i < 30; i += 1) {
      const angle = (i / 30) * Math.PI * 2;
      const h = t.heightAt(
        Math.cos(angle) * SPAWN_CLEAR_RADIUS,
        Math.sin(angle) * SPAWN_CLEAR_RADIUS,
      );
      // Low and consistent in every direction, so launch is never a cliff.
      expect(h).toBeLessThan(MAX_TERRAIN_HEIGHT * 0.5);
    }
  });
});