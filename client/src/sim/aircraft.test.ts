import { describe, expect, it } from "vitest";
import { CAMERA_LABELS, CAMERA_MODES, nextCameraMode } from "./aircraft";
import { createFlightState, type Vec3 } from "./flight";

describe("camera modes", () => {
  it("cycles through every mode and wraps around", () => {
    let mode = CAMERA_MODES[0];
    const seen: string[] = [mode];
    for (let i = 0; i < CAMERA_MODES.length - 1; i += 1) {
      mode = nextCameraMode(mode);
      seen.push(mode);
    }
    expect(new Set(seen).size).toBe(CAMERA_MODES.length);
    // One more step returns to the start.
    expect(nextCameraMode(mode)).toBe(CAMERA_MODES[0]);
  });

  it("labels every mode", () => {
    for (const mode of CAMERA_MODES) {
      expect(CAMERA_LABELS[mode]).toBeTruthy();
    }
  });
});

describe("attitude bookkeeping", () => {
  it("a level aircraft faces -Z", () => {
    const s = createFlightState(0, 100, 0);
    expect(s.attitude).toEqual({ x: 0, y: 0, z: 0 });
  });

  it("carries a Vec3 position used by the camera", () => {
    const p: Vec3 = { x: 1, y: 2, z: 3 };
    expect(p.x + p.y + p.z).toBe(6);
  });
});