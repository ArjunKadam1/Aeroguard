import { describe, expect, it } from "vitest";
import type { EventCreateRequest, PublicScenario, PublicThreat } from "../api/types";
import {
  REPLAY_BOUNDS,
  buildReplayHtml,
  replayEvents,
  replayPath,
  replayX,
  replayY,
} from "./replay";

function threat(id: string, spawn_time = 0): PublicThreat {
  return {
    id, spawn_time, speed_class: "medium", visibility_class: "clear",
    flight_pattern: "straight-transit", behavior: "steady-transit", cue_clear: true,
    swarm_id: null, swarm_index: null,
  };
}

function scenario(): PublicScenario {
  return {
    scenario_id: "SCN-000001", seed: 4242, observation_version: "1.0", difficulty: 3,
    environment: "rural", time_of_day: "day", visibility: "clear",
    sensor_quality: 1, duration_seconds: 120,
    threats: [threat("T01", 10), threat("T02", 40)],
    cue_legend: {},
  };
}

function event(type: EventCreateRequest["type"], timestamp_ms: number, threat_id?: string | null): EventCreateRequest {
  return { type, timestamp_ms, threat_id: threat_id ?? null };
}

describe("replay coordinate frame", () => {
  it("maps the airspace box onto the view with north up", () => {
    expect(replayX(REPLAY_BOUNDS.minX)).toBe(0);
    expect(replayX(REPLAY_BOUNDS.maxX)).toBe(REPLAY_BOUNDS.maxX - REPLAY_BOUNDS.minX);
    expect(replayY(REPLAY_BOUNDS.minZ)).toBe(0);
    expect(replayY(REPLAY_BOUNDS.maxZ)).toBe(REPLAY_BOUNDS.maxZ - REPLAY_BOUNDS.minZ);
  });
});

describe("replayEvents", () => {
  it("maps decision types to markers in time order", () => {
    const markers = replayEvents(
      [
        event("RESPONSE_SUBMITTED", 9000, "T01"),
        event("THREAT_DETECTED", 3000, "T01"),
        event("THREAT_SPAWNED", 1000, "T01"),
      ],
      new Set(["T01"]),
    );
    expect(markers.map((m) => m.kind)).toEqual(["spawned", "detected", "responded"]);
    expect(markers.map((m) => m.t)).toEqual([1, 3, 9]);
  });

  it("never marks simulated-response workflow records on the replay", () => {
    const workflow: EventCreateRequest = {
      type: "RESPONSE_SUBMITTED", timestamp_ms: 8000, threat_id: null,
      payload: {
        workflow: "response-simulation", phase: "completed", threat: "T01",
        outcome: "neutralized",
      },
    };
    const markers = replayEvents(
      [event("THREAT_SPAWNED", 1000, "T01"), workflow, event("RESPONSE_SUBMITTED", 9000, "T01")],
      new Set(["T01"]),
    );
    expect(markers.map((m) => m.label)).toEqual(["Spawned", "Responded"]);
  });

  it("keeps false alarms and drops unknown contacts and session noise", () => {
    const markers = replayEvents(
      [
        event("FALSE_ALARM", 5000),
        event("THREAT_DETECTED", 3000, "T99"),
        event("SESSION_STARTED", 0),
        event("THREAT_MISSED", 60000, "T01"),
      ],
      new Set(["T01"]),
    );
    expect(markers.map((m) => m.kind)).toEqual(["alarm", "missed"]);
  });
});

describe("replayPath", () => {
  it("samples visible fixes from spawn to duration", () => {
    const pts = replayPath("T01", scenario(), () => 0);
    expect(pts.length).toBeGreaterThan(0);
    expect(pts[0].t).toBeGreaterThanOrEqual(10);
    expect(pts[pts.length - 1].t).toBeLessThanOrEqual(120);
    for (const p of pts) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeGreaterThanOrEqual(0);
    }
  });

  it("returns nothing for unknown contacts", () => {
    expect(replayPath("T99", scenario(), () => 0)).toEqual([]);
  });

  it("is deterministic", () => {
    const a = replayPath("T02", scenario(), () => 0);
    const b = replayPath("T02", scenario(), () => 0);
    expect(a).toEqual(b);
  });

  it("draws a swarm member offset from its lead, reproducibly", () => {
    const base = scenario();
    const lead: PublicThreat = {
      ...base.threats[0], swarm_id: "S01", swarm_index: 0,
    };
    const wing: PublicThreat = {
      ...base.threats[1],
      spawn_time: lead.spawn_time,
      flight_pattern: lead.flight_pattern,
      swarm_id: "S01",
      swarm_index: 1,
    };
    const swarmed: PublicScenario = { ...base, threats: [lead, wing] };
    const leadPath = replayPath("T01", swarmed, () => 0);
    const wingPath = replayPath("T02", swarmed, () => 0);
    expect(wingPath.length).toBe(leadPath.length);
    // The wingman keeps its formation spacing; it never collapses onto the lead.
    expect(
      Math.hypot(wingPath[10].x - leadPath[10].x, wingPath[10].y - leadPath[10].y),
    ).toBeGreaterThan(20);
    expect(replayPath("T02", swarmed, () => 0)).toEqual(wingPath);
  });
});

describe("buildReplayHtml", () => {
  it("renders controls, scrubber, map, and seekable markers", () => {
    const markers = replayEvents([event("THREAT_DETECTED", 30000, "T01")], new Set(["T01"]));
    const html = buildReplayHtml(120, markers);
    expect(html).toContain("rp-play");
    expect(html).toContain("rp-scrub");
    expect(html).toContain("rp-map");
    expect(html).toContain("rp-tick");
    expect(html).toContain("Detected T01");
    expect(html).toContain('max="120.0"');
  });

  it("explains an empty decision record", () => {
    expect(buildReplayHtml(120, [])).toContain("no recorded decisions");
  });
});
