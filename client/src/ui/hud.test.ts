import { describe, expect, it } from "vitest";
import type { ClassificationLabel, Scenario, ThreatProfile } from "../api/types";
import { buildHudHtml, threatDotColor, type HudThreatState } from "../ui/hud";

function threat(id: string, label: ClassificationLabel, spawn_time = 1): ThreatProfile {
  return {
    id, category: "unknown_aerial_object", classification_label: label,
    expected_response: "track", spawn_time, speed_class: "medium", visibility_class: "clear",
  };
}

function scenario(threats: ThreatProfile[], overrides: Partial<Scenario> = {}): Scenario {
  return {
    scenario_id: "SCN-000001", seed: 1, generator_version: "1.0", difficulty: 5,
    environment: "urban", time_of_day: "day", visibility: "clear",
    sensor_quality: 0.8, duration_seconds: 120, threats, ...overrides,
  };
}

function states(...entries: [string, HudThreatState["stage"]][]): HudThreatState[] {
  return entries.map(([id, stage]) => ({ id, stage }));
}

describe("buildHudHtml", () => {
  it("lists every threat for a multi-threat scenario with a count header", () => {
    const html = buildHudHtml(
      scenario([threat("T01", "hostile"), threat("T02", "friendly"), threat("T03", "unknown")]),
      states(["T01", "spawned"], ["T02", "pending"], ["T03", "pending"]),
      "T02",
      60,
    );
    expect(html).toContain("3 threats");
    expect(html).toContain("T01");
    expect(html).toContain("T02");
    expect(html).toContain("T03");
    expect(html).toContain("selected");
    expect(html).toContain("on screen");
  });

  it("never reveals the ground-truth classification label", () => {
    const html = buildHudHtml(
      scenario([threat("T01", "hostile"), threat("T02", "friendly")]),
      states(["T01", "classified"], ["T02", "responded"]),
      "T01",
      30,
    );
    // Stage text reflects trainee workflow only, never the true label/response.
    expect(html).not.toContain("hostile");
    expect(html).not.toContain("friendly");
    expect(html).not.toContain("track");
    expect(html).toContain("classified");
    expect(html).toContain("resolved");
  });

  it("marks the selected threat and shows remaining time", () => {
    const html = buildHudHtml(
      scenario([threat("T01", "hostile"), threat("T02", "hostile")]),
      states(["T01", "pending"], ["T02", "pending"]),
      "T01",
      12.7,
    );
    expect(html).toContain("time left: 13s");
    expect(html).toMatch(/class="hud-threat is-selected" data-threat="T01"/);
    expect(html).not.toMatch(/class="hud-threat is-selected" data-threat="T02"/);
  });

  it("shows degraded visibility in the conditions line", () => {
    const html = buildHudHtml(
      scenario([threat("T01", "unknown")], { visibility: "poor" }),
      states(["T01", "pending"]),
      null,
      10,
    );
    expect(html).toContain("vis poor");
  });
});

describe("pending-threat countdown", () => {
  it("tells the trainee when the next threat is expected", () => {
    // duration 120, remaining 120 => elapsed 0, T02 spawns at 40s.
    const html = buildHudHtml(
      scenario([threat("T01", "hostile", 10), threat("T02", "friendly", 40)]),
      states(["T01", "spawned"], ["T02", "pending"]),
      null,
      120,
    );
    expect(html).toContain("in ~40s");
  });

  it("counts down as the session advances", () => {
    // remaining 100 => elapsed 20, so T02 is 20s away.
    const html = buildHudHtml(
      scenario([threat("T01", "hostile", 10), threat("T02", "friendly", 40)]),
      states(["T01", "spawned"], ["T02", "pending"]),
      null,
      100,
    );
    expect(html).toContain("in ~20s");
  });

  it("omits the countdown once the threat has spawned", () => {
    const html = buildHudHtml(
      scenario([threat("T01", "hostile", 40)]),
      states(["T01", "spawned"]),
      null,
      100,
    );
    expect(html).not.toContain("in ~");
  });

  it("drops the countdown once the spawn window has passed", () => {
    // elapsed 60 is past the 40s spawn time even though the stage is still pending.
    const html = buildHudHtml(
      scenario([threat("T01", "hostile", 40)]),
      states(["T01", "pending"]),
      null,
      60,
    );
    expect(html).not.toContain("in ~0s");
  });
});

describe("threatDotColor", () => {
  it("is derived from the threat id only, never the label", () => {
    expect(threatDotColor("T01")).toBe(threatDotColor("T01"));
    const colors = new Set(["T01", "T02", "T03", "T04", "T05"].map(threatDotColor));
    expect(colors.size).toBeGreaterThan(1);
  });
});
