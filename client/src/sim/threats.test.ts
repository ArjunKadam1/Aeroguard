import * as THREE from "three";
import { describe, expect, it } from "vitest";
import type { PublicThreat, SpeedClass } from "../api/types";
import {
  THREAT_CRUISE_ALTITUDE,
  airframeForId,
  createThreatView,
  isSwarmContact,
  planContact,
  threatPositionAt,
  updateThreatView,
} from "./threats";
import { AIRSPACE_X, AIRSPACE_Z, KNOWN_PATTERNS } from "./trajectory";
import { escortOffsets, swarmOffsetAt } from "./formation";
import type { SwarmContext } from "./swarm";

function threat(id: string, speed: SpeedClass = "medium"): PublicThreat {
  return {
    id, spawn_time: 1, speed_class: speed, visibility_class: "clear",
    flight_pattern: "straight-transit",
    behavior: "steady-transit", cue_clear: true,
    swarm_id: null, swarm_index: null,
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

describe("airframe yaw", () => {
  it("turns agile contacts onto their actual direction of travel", () => {
    const profile: PublicThreat = { ...threat("T02", "fast"), flight_pattern: "wide-weave" };
    const view = createThreatView(profile, 4242);
    let headingSeen = false;
    for (const t of [10, 20, 40, 60, 120]) {
      updateThreatView(view, t);
      const plan = planContact(profile, 4242, t);
      expect(view.mesh.rotation.y).toBeCloseTo(-plan.headingRad, 6);
      if (Math.abs(plan.headingRad) > 0.1) headingSeen = true;
    }
    expect(headingSeen).toBe(true);
  });

  it("keeps corridor contacts facing +x exactly as before", () => {
    const view = createThreatView(threat("T01", "medium"), 11);
    for (const t of [0, 5, 37.5, 120]) {
      updateThreatView(view, t);
      expect(view.mesh.rotation.y).toBe(0);
    }
  });
});

describe("planContact/threatPositionAt parity", () => {
  it("matches updateThreatView x/z on every pattern", () => {
    for (const pattern of KNOWN_PATTERNS) {
      const profile: PublicThreat = { ...threat("T02", "fast"), flight_pattern: pattern };
      const view = createThreatView(profile, 4242);
      for (const t of [0, 1.5, 37.5, 120]) {
        updateThreatView(view, t);
        const plan = planContact(profile, 4242, t);
        expect(plan.x).toBe(view.mesh.position.x);
        expect(plan.z).toBe(view.mesh.position.z);
        expect(plan.visible).toBe(view.mesh.visible);
      }
    }
  });

  it("composes altitude exactly like the session loop", () => {
    // Mirrors the main.ts composition term by term with a mock terrain.
    const profile = threat("T01", "medium");
    const groundAt = (x: number, z: number): number => x * 0.01 + z * 0.02;
    for (const t of [0, 5.25, 60, 150]) {
      const got = threatPositionAt(profile, 11, t, groundAt);
      const plan = planContact(profile, 11, t);
      const climb = Math.min(45, Math.max(-20, plan.altOffset));
      expect(got.x).toBe(plan.x);
      expect(got.z).toBe(plan.z);
      expect(got.y).toBe(groundAt(plan.x, plan.z) + 45 + climb + Math.sin(t) * 2);
      expect(got.visible).toBe(t >= profile.spawn_time);
    }
  });

  it("is deterministic across calls", () => {
    const profile = threat("T03", "slow");
    const groundAt = (): number => 3;
    expect(threatPositionAt(profile, 7, 42.5, groundAt))
      .toEqual(threatPositionAt(profile, 7, 42.5, groundAt));
  });
});

describe("swarm presentation", () => {
  it("flags swarm-capable contacts from the id hash only, never wings", () => {
    expect(isSwarmContact("T04")).toBe(true);
    expect(isSwarmContact("T08")).toBe(true);
    expect(isSwarmContact("T02")).toBe(false);
    // T01 is a wing: wing airframes never present as quad swarms.
    expect(isSwarmContact("T01")).toBe(false);
    for (const id of ["T01", "T02", "T03", "T04", "T05", "T06"]) {
      if (isSwarmContact(id)) expect(airframeForId(id)).toBe("quad");
    }
  });

  it("adds two escort airframes to swarm contacts on agile patterns", () => {
    const profile: PublicThreat = { ...threat("T04", "fast"), flight_pattern: "wide-weave" };
    const view = createThreatView(profile, 4242);
    expect((view.mesh.userData.escorts as unknown[]).length).toBe(2);
    for (let i = 0; i < 2; i += 1) {
      expect(view.mesh.getObjectByName(`threat-escort-T04-${i}`)).toBeTruthy();
    }
    // Escorts follow the seeded wander in the lead's local frame.
    updateThreatView(view, 41);
    const offsets = escortOffsets(4242, "T04", 40);
    for (let i = 0; i < 2; i += 1) {
      const escort = view.mesh.getObjectByName(`threat-escort-T04-${i}`) as THREE.Object3D;
      expect(escort.position.x).toBeCloseTo(offsets[i].x, 6);
      expect(escort.position.y).toBeCloseTo(offsets[i].y, 6);
      expect(escort.position.z).toBeCloseTo(offsets[i].z, 6);
    }
  });

  it("keeps escorts out of the corridor, off wings, and off solo quads", () => {
    const corridor: PublicThreat = { ...threat("T04", "medium"), flight_pattern: "straight-transit" };
    const wing: PublicThreat = { ...threat("T01", "medium"), flight_pattern: "wide-weave" };
    const soloQuad: PublicThreat = { ...threat("T02", "medium"), flight_pattern: "erratic-jink" };
    for (const profile of [corridor, wing, soloQuad]) {
      const view = createThreatView(profile, 11);
      expect((view.mesh.userData.escorts as unknown[]).length).toBe(0);
      expect(view.mesh.getObjectByName(`threat-escort-${profile.id}-0`)).toBeUndefined();
    }
  });

  it("leaves the contact's plan position and visibility untouched", () => {
    const profile: PublicThreat = { ...threat("T04", "fast"), flight_pattern: "erratic-jink" };
    const view = createThreatView(profile, 4242);
    for (const t of [0, 12, 55, 120]) {
      updateThreatView(view, t);
      const plan = planContact(profile, 4242, t);
      expect(view.mesh.position.x).toBe(plan.x);
      expect(view.mesh.position.z).toBe(plan.z);
      expect(view.mesh.visible).toBe(plan.visible);
    }
  });
});

describe("scenario-declared swarms", () => {
  function pair(): { lead: PublicThreat; wing: PublicThreat; group: SwarmContext } {
    const lead: PublicThreat = {
      ...threat("T01", "fast"),
      flight_pattern: "wide-weave",
      swarm_id: "S01",
      swarm_index: 0,
    };
    const wing: PublicThreat = {
      ...threat("T04", "fast"),
      flight_pattern: "wide-weave",
      swarm_id: "S01",
      swarm_index: 1,
    };
    return { lead, wing, group: { lead, index: 1, count: 2 } };
  }

  it("flies a wingman at its rotated slot around the lead's plan", () => {
    const { lead, wing, group } = pair();
    for (const t of [1, 20, 75, 140]) {
      const leadPlan = planContact(lead, 4242, t);
      const wingPlan = planContact(wing, 4242, t, group);
      const offset = swarmOffsetAt(4242, wing.id, 1, Math.max(0, t - lead.spawn_time));
      const cos = Math.cos(leadPlan.headingRad);
      const sin = Math.sin(leadPlan.headingRad);
      expect(wingPlan.x).toBeCloseTo(leadPlan.x + offset.x * cos - offset.z * sin, 9);
      expect(wingPlan.z).toBeCloseTo(leadPlan.z + offset.x * sin + offset.z * cos, 9);
      expect(wingPlan.visible).toBe(leadPlan.visible);
      expect(wingPlan.headingRad).toBe(leadPlan.headingRad);
    }
  });

  it("keeps the formation spacing while both contacts fly", () => {
    const { lead, wing, group } = pair();
    for (let t = 0; t <= 180; t += 5) {
      const leadPlan = planContact(lead, 4242, t);
      const wingPlan = planContact(wing, 4242, t, group);
      expect(
        Math.hypot(wingPlan.x - leadPlan.x, wingPlan.z - leadPlan.z),
      ).toBeGreaterThan(20);
    }
  });

  it("shares the lead's visibility, so the group arrives together", () => {
    const { lead, wing, group } = pair();
    expect(planContact(wing, 4242, lead.spawn_time - 0.5, group).visible).toBe(false);
    expect(planContact(wing, 4242, lead.spawn_time + 0.5, group).visible).toBe(true);
  });

  it("does not add decorative escorts to real swarm members", () => {
    const { wing, group } = pair();
    const grouped = createThreatView(wing, 11, group);
    expect((grouped.mesh.userData.escorts as unknown[]).length).toBe(0);
    expect(grouped.mesh.getObjectByName("threat-escort-T04-0")).toBeUndefined();
    // The same airframe outside a declared swarm keeps the Phase D art.
    const solo = createThreatView({ ...wing, swarm_id: null, swarm_index: null }, 11);
    expect((solo.mesh.userData.escorts as unknown[]).length).toBe(2);
  });

  it("moves the rendered member with the group plan", () => {
    const { wing, group } = pair();
    const view = createThreatView(wing, 4242, group);
    for (const t of [10, 60, 120]) {
      updateThreatView(view, t);
      const plan = planContact(wing, 4242, t, group);
      expect(view.mesh.position.x).toBeCloseTo(plan.x, 9);
      expect(view.mesh.position.z).toBeCloseTo(plan.z, 9);
      expect(view.mesh.visible).toBe(plan.visible);
      expect(view.mesh.rotation.y).toBe(plan.headingRad === 0 ? 0 : -plan.headingRad);
    }
  });

  it("composes the member's terrain-following position identically", () => {
    const { wing, group } = pair();
    const groundAt = (x: number, z: number): number => 3 + x * 0.01 + z * 0.02;
    const t = 70;
    const plan = planContact(wing, 4242, t, group);
    const position = threatPositionAt(wing, 4242, t, groundAt, group);
    const climb = Math.min(45, Math.max(-20, plan.altOffset));
    expect(position.x).toBe(plan.x);
    expect(position.z).toBe(plan.z);
    expect(position.y).toBe(
      groundAt(plan.x, plan.z) + THREAT_CRUISE_ALTITUDE + climb + Math.sin(t) * 2,
    );
  });

  it("keeps every member inside the airspace box on every pattern", () => {
    for (const pattern of KNOWN_PATTERNS) {
      for (const leadId of ["T01", "T04"]) {
        for (const speed of ["slow", "medium", "fast"] as const) {
          const lead: PublicThreat = {
            ...threat(leadId, speed), flight_pattern: pattern, spawn_time: 0,
          };
          for (const wingId of ["T02", "T04", "T05"]) {
            for (const index of [1, 3, 4]) {
              const wing: PublicThreat = {
                ...threat(wingId, speed),
                flight_pattern: pattern,
                spawn_time: 0,
                swarm_id: "S01",
                swarm_index: index,
              };
              const group: SwarmContext = { lead, index, count: 5 };
              for (let t = 0; t <= 180; t += 5) {
                const p = planContact(wing, 11, t, group);
                expect(Math.abs(p.x)).toBeLessThanOrEqual(AIRSPACE_X + 0.001);
                expect(Math.abs(p.z)).toBeLessThanOrEqual(AIRSPACE_Z + 0.001);
              }
            }
          }
        }
      }
    }
  });
});
