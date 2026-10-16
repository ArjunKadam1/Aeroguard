import * as THREE from "three";
import { describe, expect, it } from "vitest";
import type { PublicThreat, SpeedClass } from "../api/types";
import { airframeForId, createThreatView, updateThreatView } from "./threats";

function threat(id: string, speed: SpeedClass = "medium"): PublicThreat {
  return {
    id, spawn_time: 1, speed_class: speed, visibility_class: "clear",
    flight_pattern: "straight-transit",
    behavior: "steady-transit", cue_clear: true,
  };
}

function colorOf(id: string): number {
  const view = createThreatView(threat(id), 11);
  // Accent dot carries the id-hash color; the airframe stays dark.
  const core = view.mesh.getObjectByName(`threat-core-${id}`) as THREE.Mesh;
  const material = core.material as THREE.MeshBasicMaterial;
  return material.color.getHex();
}

describe("airframeForId", () => {
  it("is deterministic per id", () => {
    expect(airframeForId("T01")).toBe(airframeForId("T01"));
  });

  it("uses both airframes across contacts, independent of any label", () => {
    // Only the id feeds the choice: the profile type carries no label at all.
    const kinds = new Set(
      ["T01", "T02", "T03", "T04", "T05", "T06"].map((id) => airframeForId(id)),
    );
    expect(kinds).toEqual(new Set(["quad", "wing"]));
  });
});

describe("createThreatView", () => {
  it("derives color from the threat id only", () => {
    expect(colorOf("T01")).toBe(colorOf("T01"));
  });

  it("still varies color across different threats", () => {
    const seen = new Set(
      ["T01", "T02", "T03", "T04", "T05"].map((id) => colorOf(id)),
    );
    expect(seen.size).toBeGreaterThan(1);
  });

  it("builds the airframe matching the id hash", () => {
    const view = createThreatView(threat("T01"), 11);
    const kind = airframeForId("T01");
    expect(view.mesh.userData.airframe).toBe(kind);
    expect(view.mesh.getObjectByName(`threat-${kind}-T01`)).toBeTruthy();
  });

  it("carries the scenario seed on the view for trajectory derivation", () => {
    const view = createThreatView(threat("T01"), 4242);
    expect(view.mesh.userData.seed).toBe(4242);
  });

  it("fits red/green nav lights port/starboard of travel", () => {
    const view = createThreatView(threat("T01"), 11);
    const colors = new Set<number>();
    view.mesh.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (mesh.isMesh) {
        const hex = (mesh.material as THREE.MeshBasicMaterial).color?.getHex();
        if (hex === 0xff2d2d || hex === 0x2dff5e) colors.add(hex);
      }
    });
    expect(colors).toEqual(new Set([0xff2d2d, 0x2dff5e]));
  });

  it("keeps every light fog-free so contacts read at any distance", () => {
    const view = createThreatView(threat("T01"), 11);
    view.mesh.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (mesh.isMesh) {
        expect((mesh.material as THREE.MeshBasicMaterial).fog).toBe(false);
      }
    });
  });

  it("uses a self-lit accent that ignores fog, on a dark airframe", () => {
    const view = createThreatView(threat("T01"), 11);
    const core = view.mesh.getObjectByName("threat-core-T01") as THREE.Mesh;
    const coreMat = core.material as THREE.MeshBasicMaterial;
    // fog:false is what stops the threat washing out against the sky.
    expect(coreMat.fog).toBe(false);

    const airframe = view.mesh.getObjectByName(`threat-${airframeForId("T01")}-T01`) as THREE.Group;
    const body = airframe.children[0] as THREE.Mesh;
    const bodyMat = body.material as THREE.MeshBasicMaterial;
    expect(bodyMat.fog).toBe(false);
    // The body must be much darker than the accent to read as a silhouette.
    expect(bodyMat.color.getHex()).toBeLessThan(coreMat.color.getHex());
  });

  it("blinks the strobe roughly once a second, staggered per contact", () => {
    const view = createThreatView(threat("T01"), 11);
    updateThreatView(view, 2);
    const strobe = view.mesh.getObjectByName("threat-strobe-T01") as THREE.Mesh;
    const states = new Set<boolean>();
    for (let t = 1; t < 4; t += 0.05) {
      updateThreatView(view, t);
      states.add(strobe.visible);
    }
    // Mostly off with brief flashes -- never stuck on, never stuck off.
    expect(states).toEqual(new Set([true, false]));
  });
});

describe("updateThreatView", () => {
  function xAt(profile: PublicThreat, elapsedSec: number): number {
    const view = createThreatView(profile, 11);
    updateThreatView(view, elapsedSec);
    return view.mesh.position.x;
  }

  it("stays inside the corridor for the whole session at every speed", () => {
    const speeds: SpeedClass[] = ["slow", "medium", "fast"];
    for (const speed of speeds) {
      const profile = threat("T01", speed);
      for (let t = 0; t <= 600; t += 0.5) {
        const x = xAt(profile, t);
        expect(x).toBeGreaterThanOrEqual(-70);
        expect(x).toBeLessThan(50);
      }
    }
  });

  it("re-enters the corridor instead of flying off permanently", () => {
    const profile = threat("T01", "medium");
    // One lap is 120 units at 6 units/sec = 20s, measured from the spawn time.
    const atSpawn = xAt(profile, profile.spawn_time);
    expect(xAt(profile, profile.spawn_time + 20)).toBeCloseTo(atSpawn, 5);
    expect(xAt(profile, profile.spawn_time + 40)).toBeCloseTo(atSpawn, 5);
  });

  it("advances forward, wrapping back to the start rather than jumping off-screen", () => {
    const profile = threat("T01", "fast");
    let previous = xAt(profile, profile.spawn_time);
    // A lap is 120 units at 10 units/sec = 12s. Each step must either move
    // forward or wrap back to the start of the corridor, never overshoot past it.
    for (let t = profile.spawn_time + 0.5; t <= profile.spawn_time + 11; t += 0.5) {
      const x = xAt(profile, t);
      const wrapped = x < previous;
      if (wrapped) {
        expect(x).toBeGreaterThanOrEqual(-70);
        expect(x).toBeLessThan(-60);
      } else {
        expect(x).toBeGreaterThan(previous);
      }
      previous = x;
    }
  });

  it("keeps the threat hidden until its spawn time", () => {
    const profile = threat("T01", "medium");
    const view = createThreatView(profile, 11);
    updateThreatView(view, 0);
    expect(view.mesh.visible).toBe(false);
    updateThreatView(view, 1);
    expect(view.mesh.visible).toBe(true);
  });

  it("stays deterministic for a given elapsed time", () => {
    const profile = threat("T01", "medium");
    expect(xAt(profile, 37.5)).toBe(xAt(profile, 37.5));
  });
});
