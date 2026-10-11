import * as THREE from "three";
import { describe, expect, it } from "vitest";
import type { ClassificationLabel, SpeedClass, ThreatProfile } from "../api/types";
import { createThreatView, updateThreatView } from "./threats";

function threat(id: string, label: ClassificationLabel, speed: SpeedClass = "medium"): ThreatProfile {
  return {
    id, category: "unknown_aerial_object", classification_label: label,
    expected_response: "track", spawn_time: 1, speed_class: speed, visibility_class: "clear",
  };
}

function colorOf(id: string, label: ClassificationLabel): number {
  const view = createThreatView(threat(id, label));
  // Core mesh carries the id-hash color; the shell is a fixed dark outline.
  const core = view.mesh.getObjectByName(`threat-core-${id}`) as THREE.Mesh;
  const material = core.material as THREE.MeshBasicMaterial;
  return material.color.getHex();
}

describe("createThreatView", () => {
  it("derives color from the threat id, not the ground-truth classification label", () => {
    expect(colorOf("T01", "hostile")).toBe(colorOf("T01", "friendly"));
    expect(colorOf("T01", "hostile")).toBe(colorOf("T01", "civilian"));
    expect(colorOf("T01", "hostile")).toBe(colorOf("T01", "unknown"));
  });

  it("still varies color across different threats", () => {
    const seen = new Set(
      ["T01", "T02", "T03", "T04", "T05"].map((id) => colorOf(id, "hostile")),
    );
    expect(seen.size).toBeGreaterThan(1);
  });

  it("uses a self-lit core that ignores fog, inside a dark outline shell", () => {
    const view = createThreatView(threat("T01", "hostile"));
    const core = view.mesh.getObjectByName("threat-core-T01") as THREE.Mesh;
    const coreMat = core.material as THREE.MeshBasicMaterial;
    // fog:false is what stops the threat washing out against the sky.
    expect(coreMat.fog).toBe(false);

    const shell = view.mesh.children[0] as THREE.Mesh;
    const shellMat = shell.material as THREE.MeshBasicMaterial;
    expect(shellMat.fog).toBe(false);
    // The shell must be much darker than the core to read as a rim.
    const coreLum = coreMat.color.getHex();
    const shellLum = shellMat.color.getHex();
    expect(shellLum).toBeLessThan(coreLum);
  });
});

describe("updateThreatView", () => {
  function xAt(profile: ThreatProfile, elapsedSec: number): number {
    const view = createThreatView(profile);
    updateThreatView(view, elapsedSec);
    return view.mesh.position.x;
  }

  it("stays inside the corridor for the whole session at every speed", () => {
    const speeds: SpeedClass[] = ["slow", "medium", "fast"];
    for (const speed of speeds) {
      const profile = threat("T01", "hostile", speed);
      for (let t = 0; t <= 600; t += 0.5) {
        const x = xAt(profile, t);
        expect(x).toBeGreaterThanOrEqual(-70);
        expect(x).toBeLessThan(50);
      }
    }
  });

  it("re-enters the corridor instead of flying off permanently", () => {
    const profile = threat("T01", "hostile", "medium");
    // One lap is 120 units at 6 units/sec = 20s, measured from the spawn time.
    const atSpawn = xAt(profile, profile.spawn_time);
    expect(xAt(profile, profile.spawn_time + 20)).toBeCloseTo(atSpawn, 5);
    expect(xAt(profile, profile.spawn_time + 40)).toBeCloseTo(atSpawn, 5);
  });

  it("advances forward, wrapping back to the start rather than jumping off-screen", () => {
    const profile = threat("T01", "hostile", "fast");
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
    const profile = threat("T01", "hostile", "medium");
    const view = createThreatView(profile);
    updateThreatView(view, 0);
    expect(view.mesh.visible).toBe(false);
    updateThreatView(view, 1);
    expect(view.mesh.visible).toBe(true);
  });

  it("stays deterministic for a given elapsed time", () => {
    const profile = threat("T01", "hostile", "medium");
    expect(xAt(profile, 37.5)).toBe(xAt(profile, 37.5));
  });
});
