import { describe, expect, it } from "vitest";
import type { PublicScenario, PublicThreat } from "../api/types";
import { buildHudHtml, prioritySorted, threatDotColor, type HudThreatState } from "../ui/hud";

const LEGEND = {
  "steady-transit": "steady, level flight — often friendly",
  indeterminate: "signature unreadable under current conditions",
};

function threat(id: string, behavior = "steady-transit", spawn_time = 1): PublicThreat {
  return {
    id, spawn_time, speed_class: "medium", visibility_class: "clear",
    flight_pattern: "straight-transit",
    behavior, cue_clear: behavior !== "indeterminate",
    swarm_id: null, swarm_index: null,
  };
}

function scenario(threats: PublicThreat[], overrides: Partial<PublicScenario> = {}): PublicScenario {
  return {
    scenario_id: "SCN-000001", seed: 1, observation_version: "1.0", difficulty: 5,
    environment: "urban", time_of_day: "day", visibility: "clear",
    sensor_quality: 0.8, duration_seconds: 120, threats, cue_legend: LEGEND,
    ...overrides,
  };
}

function states(...entries: [string, HudThreatState["stage"]][]): HudThreatState[] {
  return entries.map(([id, stage]) => ({ id, stage, behavior: "steady-transit", track: "confirmed" }));
}

describe("buildHudHtml", () => {
  it("lists observed contacts with a count header", () => {
    const html = buildHudHtml(
      scenario([threat("T01"), threat("T02"), threat("T03")]),
      states(["T01", "spawned"], ["T02", "spawned"], ["T03", "detected"]),
      "T02",
      60,
    );
    expect(html).toContain("3 contacts observed");
    expect(html).toContain("T01");
    expect(html).toContain("T02");
    expect(html).toContain("T03");
    expect(html).toContain("selected");
    expect(html).toContain("on screen");
  });

  it("shows the behavior signature next to each contact", () => {
    const html = buildHudHtml(
      scenario([threat("T01", "orbiting")]),
      [{ id: "T01", stage: "spawned", behavior: "orbiting", track: "confirmed" }],
      "T01",
      30,
    );
    expect(html).toContain("orbiting");
  });

  it("shows the track lifecycle state next to each contact", () => {
    const html = buildHudHtml(
      scenario([threat("T01")]),
      [{ id: "T01", stage: "spawned", behavior: "steady-transit", track: "coasting" }],
      null,
      30,
    );
    expect(html).toContain("coasting");
  });

  it("renders the shared cue legend without per-contact answers", () => {
    const html = buildHudHtml(
      scenario([threat("T01")]),
      states(["T01", "spawned"]),
      null,
      30,
    );
    expect(html).toContain("SIGNATURES");
    expect(html).toContain("steady-transit");
    expect(html).not.toContain("classification_label");
    expect(html).not.toContain("expected_response");
  });

  it("shows the station sensor section with no radar fitted", () => {
    const html = buildHudHtml(
      scenario([threat("T01")]),
      states(["T01", "spawned"]),
      null,
      30,
      "station",
    );
    expect(html).toContain("SENSORS · STATION");
    expect(html).toContain("not fitted");
  });

  it("shows the scout radar capability and degradation reasons", () => {
    const html = buildHudHtml(
      scenario([threat("T01")], { time_of_day: "night", visibility: "poor", sensor_quality: 0.4 }),
      states(["T01", "spawned"]),
      null,
      30,
      "scout",
    );
    expect(html).toContain("SENSORS · SCOUT");
    expect(html).toContain("400u");
    expect(html).toContain("night");
    expect(html).toContain("poor visibility");
  });

  it("marks the selected threat and shows remaining time", () => {
    const html = buildHudHtml(
      scenario([threat("T01"), threat("T02")]),
      states(["T01", "pending"], ["T02", "pending"]),
      "T01",
      12.7,
    );
    expect(html).toContain("time left: 13s");
    expect(html).toMatch(/class="hud-threat is-selected" data-threat="T01"/);
    expect(html).not.toMatch(/class="hud-threat is-selected" data-threat="T02"/);
  });

  it("carries every row id as data-threat for the 2D selection path", () => {
    const html = buildHudHtml(
      scenario([threat("T01"), threat("T02")]),
      states(["T01", "spawned"], ["T02", "detected"]),
      null,
      10,
    );
    expect(html).toMatch(/data-threat="T01"/);
    expect(html).toMatch(/data-threat="T02"/);
  });

  it("shows degraded visibility in the conditions line", () => {
    const html = buildHudHtml(
      scenario([threat("T01", "erratic")], { visibility: "poor" }),
      states(["T01", "pending"]),
      null,
      10,
    );
    expect(html).toContain("vis poor");
  });
});

describe("pending-threat timing privacy", () => {
  it("never shows a spawn countdown for pending threats", () => {
    // duration 120, remaining 120 => elapsed 0, T02 spawns at 40s.
    const html = buildHudHtml(
      scenario([threat("T01", "steady-transit", 10), threat("T02", "orbiting", 40)]),
      states(["T01", "spawned"], ["T02", "pending"]),
      null,
      120,
    );
    expect(html).not.toContain("in ~");
    expect(html).not.toContain("hud-eta");
  });

  it("does not leak spawn timing as the session advances", () => {
    // remaining 100 => elapsed 20, so T02 is 20s away in ground truth.
    const html = buildHudHtml(
      scenario([threat("T01", "steady-transit", 10), threat("T02", "orbiting", 40)]),
      states(["T01", "spawned"], ["T02", "pending"]),
      null,
      100,
    );
    expect(html).not.toContain("in ~20s");
    expect(html).not.toContain("40");
  });

  it("still reports the pending workflow stage without timing", () => {
    const html = buildHudHtml(
      scenario([threat("T01", "steady-transit", 40)]),
      states(["T01", "pending"]),
      null,
      60,
    );
    expect(html).toContain("waiting");
    expect(html).not.toContain("in ~");
  });
});

describe("threatDotColor", () => {
  it("is derived from the threat id only, never the label", () => {
    expect(threatDotColor("T01")).toBe(threatDotColor("T01"));
    const colors = new Set(["T01", "T02", "T03", "T04", "T05"].map(threatDotColor));
    expect(colors.size).toBeGreaterThan(1);
  });
});

describe("prioritySorted", () => {
  it("keeps unresolved contacts in arrival order and sinks resolved ones", () => {
    const rows = states(
      ["T01", "responded"],
      ["T02", "classified"],
      ["T03", "spawned"],
      ["T04", "responded"],
      ["T05", "detected"],
    );
    expect(prioritySorted(rows).map((row) => row.id)).toEqual(["T02", "T03", "T05", "T01", "T04"]);
  });

  it("does not mutate the array it is given", () => {
    const rows = states(["T01", "spawned"], ["T02", "responded"]);
    const copy = [...rows];
    prioritySorted(rows);
    expect(rows).toEqual(copy);
  });
});
