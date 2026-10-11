import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { patchFacadeUvShader } from "./world";

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