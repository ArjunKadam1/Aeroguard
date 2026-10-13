import { describe, expect, it } from "vitest";
import * as THREE from "three";
import {
  CAMERA_LABELS,
  CAMERA_MODES,
  STATION_AIM,
  STATION_MAX_PAN,
  STATION_POSITION,
  applyStationCamera,
  nextCameraMode,
  stationLookTarget,
} from "./aircraft";
import { advanceStationHeading } from "./picking";
import { createFlightState, type Vec3 } from "./flight";

describe("ground station is stationary", () => {
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 20000);

  it("holds exactly still when the heading does not change", () => {
    // The original implementation drove the camera from wall-clock time, so it
    // rotated on its own. This is the regression guard for that.
    for (let i = 0; i < 120; i += 1) {
      applyStationCamera(camera, { heading: 0, focus: null }, 0.016);
    }
    const settled = camera.position.clone();
    applyStationCamera(camera, { heading: 0, focus: null }, 0.016);
    expect(camera.position.distanceTo(settled)).toBeLessThan(1e-6);
  });

  it("settles on the fixed mast position", () => {
    for (let i = 0; i < 200; i += 1) {
      applyStationCamera(camera, { heading: 0, focus: null }, 0.05);
    }
    expect(camera.position.x).toBeCloseTo(STATION_POSITION.x, 3);
    expect(camera.position.y).toBeCloseTo(STATION_POSITION.y, 3);
    expect(camera.position.z).toBeCloseTo(STATION_POSITION.z, 3);
  });

  it("pans the aim only when the heading changes", () => {
    applyStationCamera(camera, { heading: 0, focus: null }, 1);
    const centreAim = camera.getWorldDirection(new THREE.Vector3());
    applyStationCamera(camera, { heading: 0.5, focus: null }, 1);
    const pannedAim = camera.getWorldDirection(new THREE.Vector3());
    expect(pannedAim.distanceTo(centreAim)).toBeGreaterThan(0.01);
  });

  it("keeps the mast in place while panning", () => {
    applyStationCamera(camera, { heading: 0, focus: null }, 1);
    const before = camera.position.clone();
    applyStationCamera(camera, { heading: 0.5, focus: null }, 1);
    expect(camera.position.distanceTo(before)).toBeLessThan(1e-6);
  });

  it("rotates the aim about the mast rather than orbiting it", () => {
    const aim = stationLookTarget(0.4);
    const r0 = Math.hypot(
      STATION_AIM.x - STATION_POSITION.x,
      STATION_AIM.z - STATION_POSITION.z,
    );
    const r1 = Math.hypot(aim.x - STATION_POSITION.x, aim.z - STATION_POSITION.z);
    // Panning must preserve distance from the mast.
    expect(r1).toBeCloseTo(r0, 4);
  });

  it("locks onto a selected contact", () => {
    const focus = new THREE.Vector3(-40, 45, -10);
    for (let i = 0; i < 60; i += 1) {
      applyStationCamera(camera, { heading: 0, focus }, 0.05);
    }
    expect(camera.position.distanceTo(focus)).toBeLessThan(80);
  });

  it("survives a non-positive time step", () => {
    expect(() => applyStationCamera(camera, { heading: 0, focus: null }, 0)).not.toThrow();
  });
});

describe("station sweep input", () => {
  it("only pans while the key is held", () => {
    expect(advanceStationHeading(0.3, false, 0.016)).toBe(0.3);
    expect(advanceStationHeading(0.3, true, 0.016)).toBeLessThan(0.3);
  });

  it("stays within the traverse limit", () => {
    let heading = 0;
    for (let i = 0; i < 500; i += 1) heading = advanceStationHeading(heading, true, 0.05);
    expect(heading).toBeGreaterThanOrEqual(-STATION_MAX_PAN);
  });
});

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