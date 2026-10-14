import { describe, expect, it } from "vitest";
import * as THREE from "three";
import {
  FACADE_PALETTES,
  districtHeight,
  facadeArchetype,
  facadeTint,
  footprintHalfExtents,
  footprintsOverlap,
  patchFacadeUvShader,
  streetlightPositions,
} from "./world";

// Building facades are instanced boxes scaled per instance, so their UVs are
// corrected in a vertex-shader patch. An onBeforeCompile patch that fails to
// apply is silent -- three just compiles the unpatched shader -- so these tests
// exercise the patch function directly.
const REAL_VERTEX = [
  "#include <common>",
  "#include <uv_pars_vertex>",
  "#include <uv_vertex>",
  "void main() {",
  "  gl_Position = vec4( transformed, 1.0 );",
  "}",
].join("\n");

describe("patchFacadeUvShader", () => {
  it("declares the per-instance scale attribute", () => {
    const shader = { vertexShader: REAL_VERTEX };
    patchFacadeUvShader(shader, 0.29);
    expect(shader.vertexShader).toContain("attribute vec3 instanceScale");
  });

  it("scales both the albedo and emissive UVs by instance size", () => {
    const shader = { vertexShader: REAL_VERTEX };
    patchFacadeUvShader(shader, 0.29);
    expect(shader.vertexShader).toContain("vMapUv *=");
    expect(shader.vertexShader).toContain("vEmissiveMapUv *=");
  });

  it("uses the supplied window density", () => {
    const shader = { vertexShader: REAL_VERTEX };
    patchFacadeUvShader(shader, 0.5);
    expect(shader.vertexShader).toContain("0.50000");
  });

  it("guards each varying behind its own define", () => {
    const shader = { vertexShader: REAL_VERTEX };
    patchFacadeUvShader(shader, 0.29);
    // USE_EMISSIVEMAP is only defined when the material has an emissiveMap;
    // referencing the varying unconditionally would fail to compile without one.
    expect(shader.vertexShader).toContain("#ifdef USE_MAP");
    expect(shader.vertexShader).toContain("#ifdef USE_EMISSIVEMAP");
  });

  it("tall buildings get more window rows than short ones", () => {
    const shader = { vertexShader: REAL_VERTEX };
    patchFacadeUvShader(shader, 0.29);
    // The y term must be the instance height, not width.
    expect(shader.vertexShader).toContain("instanceScale.y");
  });

  it("leaves the shader untouched if three renames an anchor", () => {
    const shader = { vertexShader: "void main() {}" };
    patchFacadeUvShader(shader, 0.29);
    // No anchors to replace, so nothing is injected -- which is exactly the
    // silent failure this guard exists to make visible.
    expect(shader.vertexShader).not.toContain("instanceScale");
  });
});

describe("instance scale attribute", () => {
  it("InstancedBufferAttribute holds per-instance dimensions", () => {
    const scales = new Float32Array([16, 40, 16, 20, 12, 24]);
    const attr = new THREE.InstancedBufferAttribute(scales, 3);
    expect(attr.count).toBe(2);
    expect(attr.itemSize).toBe(3);
    expect(attr.getX(0)).toBe(16);
    expect(attr.getY(1)).toBe(12);
  });
});

describe("districtHeight", () => {
  const half = () => 0.5;

  it("clusters tall towers downtown and keeps sprawl low", () => {
    const downtown = districtHeight(half, 0, 0);
    const sprawl = districtHeight(half, 900, 0);
    // rng 0.5: 10 + 10 + core * (30 + 22.5); core 1 downtown, 0 at 900.
    expect(downtown).toBeCloseTo(72.5, 6);
    expect(sprawl).toBeCloseTo(20, 6);
    expect(downtown).toBeGreaterThan(sprawl);
  });

  it("stays within plausible bounds", () => {
    expect(districtHeight(() => 0, 0, 0)).toBeGreaterThanOrEqual(10);
    expect(districtHeight(() => 0.9999, 0, 0)).toBeLessThan(110);
  });
});

describe("facadeTint", () => {
  it("stays at or below 1.0 so the sun cannot clip it", () => {
    for (let i = 0; i < 50; i += 1) {
      const seed = i / 50;
      for (const channel of facadeTint(() => seed)) {
        expect(channel).toBeGreaterThan(0.6);
        expect(channel).toBeLessThanOrEqual(1.0);
      }
    }
  });

  it("spreads warm and cool across instances", () => {
    const hues = new Set(
      Array.from({ length: 20 }, (_, i) => {
        const [r, , b] = facadeTint(() => i / 20);
        return Math.sign(r - b);
      }),
    );
    expect(hues.size).toBeGreaterThan(1);
  });
});

describe("streetlightPositions", () => {
  it("stands lamps on the road edges, outside the launch pad", () => {
    const spots = streetlightPositions();
    expect(spots.length).toBeGreaterThan(200);
    for (const { x, z, armX, armZ } of spots) {
      // Exactly one axis sits ~8.5u off a street line (the kerb); the arm
      // reaches back toward the road along that axis.
      const xOff = Math.abs((((x - 45) % 90) + 90) % 90);
      const zOff = Math.abs((((z - 45) % 90) + 90) % 90);
      const xEdge = Math.min(xOff, 90 - xOff);
      const zEdge = Math.min(zOff, 90 - zOff);
      const onVerticalEdge = Math.abs(xEdge - 8.5) < 0.001 && zEdge > 20;
      const onHorizontalEdge = Math.abs(zEdge - 8.5) < 0.001 && xEdge > 20;
      expect(onVerticalEdge || onHorizontalEdge).toBe(true);
      // The arm always reaches back toward the road it serves.
      if (onVerticalEdge) {
        const lineX = Math.round((x - 45) / 90) * 90 + 45;
        expect(armZ).toBe(0);
        expect(armX).toBe(-Math.sign(x - lineX));
      } else {
        const lineZ = Math.round((z - 45) / 90) * 90 + 45;
        expect(armX).toBe(0);
        expect(armZ).toBe(-Math.sign(z - lineZ));
      }
      expect(Math.hypot(x, z)).toBeGreaterThanOrEqual(150);
    }
  });

  it("alternates kerb sides along the streets", () => {
    const spots = streetlightPositions().filter(({ armX }) => armX !== 0);
    const sides = new Set(
      spots.map(({ x }) => {
        const lineX = Math.round((x - 45) / 90) * 90 + 45;
        return Math.sign(x - lineX);
      }),
    );
    expect(sides).toEqual(new Set([-1, 1]));
  });

  it("is deterministic", () => {
    expect(streetlightPositions()).toEqual(streetlightPositions());
  });
});

describe("facadeArchetype", () => {
  it("zones glass downtown, mixed ring, concrete sprawl", () => {
    expect(facadeArchetype(0, 0, 0.9)).toBe("glass");
    expect(facadeArchetype(100, 100, 0.9)).toBe("glass");
    expect(facadeArchetype(900, 0, 0.1)).toBe("concrete");
    expect(facadeArchetype(400, 0, 0.1)).toBe("brick");
    expect(facadeArchetype(400, 0, 0.9)).toBe("concrete");
  });

  it("uses all three archetypes across a city", () => {
    const seen = new Set<string>();
    for (let x = -700; x <= 700; x += 70) {
      seen.add(facadeArchetype(x, 100, 0.2));
      seen.add(facadeArchetype(x, 100, 0.8));
    }
    expect(seen).toEqual(new Set(["glass", "brick", "concrete"]));
  });
});

describe("facade palettes", () => {
  it("gives glass the densest grid and brick punched openings", () => {
    expect(FACADE_PALETTES.glass.cols).toBeGreaterThan(FACADE_PALETTES.brick.cols);
    expect(FACADE_PALETTES.glass.rows).toBeGreaterThan(FACADE_PALETTES.brick.rows);
    expect(FACADE_PALETTES.glass.pad).toBeLessThan(FACADE_PALETTES.brick.pad);
  });

  it("keeps night windows sparse for mood on every archetype", () => {
    for (const palette of Object.values(FACADE_PALETTES)) {
      expect(palette.litNightFraction).toBeLessThanOrEqual(0.1);
      expect(palette.litNightFraction).toBeGreaterThan(0);
    }
  });
});

describe("footprints", () => {
  it("measures rotated half-extents", () => {
    expect(footprintHalfExtents(20, 10, 0)).toEqual([10, 5]);
    const [hx, hz] = footprintHalfExtents(20, 20, Math.PI / 4);
    expect(hx).toBeCloseTo(14.142, 2);
    expect(hz).toBeCloseTo(14.142, 2);
  });

  it("detects intersection with padding", () => {
    const a = { x: 0, z: 0, hx: 10, hz: 10 };
    expect(footprintsOverlap(a, { x: 15, z: 0, hx: 10, hz: 10 })).toBe(true);
    expect(footprintsOverlap(a, { x: 15, z: 0, hx: 10, hz: 10 }, 0)).toBe(true);
    expect(footprintsOverlap(a, { x: 26, z: 0, hx: 10, hz: 10 }, 0)).toBe(false);
    // Padding rejects near-misses: 24 apart with 6 padding still overlaps.
    expect(footprintsOverlap(a, { x: 24, z: 0, hx: 10, hz: 10 })).toBe(true);
    expect(footprintsOverlap(a, { x: 24, z: 0, hx: 10, hz: 10 }, 0)).toBe(false);
  });
});