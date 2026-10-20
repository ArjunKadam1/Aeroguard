import { describe, expect, it } from "vitest";
import type { ScriptedScenarioSummary } from "../api/types";
import {
  ASSIST_HINT,
  ASSIST_LABEL,
  ASSIST_MODES,
  MODE_HINT,
  MODE_LABEL,
  OPERATOR_MODES,
  buildStartPanelHtml,
  createStartPanelState,
  minimumDifficulty,
  parseStartForm,
  resolveScenarioKey,
} from "./startPanel";

describe("operator mode", () => {
  it("defaults to ground station, the role the problem statement describes", () => {
    expect(createStartPanelState().mode).toBe("station");
  });

  it("offers both operator roles", () => {
    expect(OPERATOR_MODES).toEqual(["station", "airborne"]);
    for (const mode of OPERATOR_MODES) {
      expect(MODE_LABEL[mode]).toBeTruthy();
      expect(MODE_HINT[mode]).toBeTruthy();
    }
  });

  it("renders both role buttons with the active one marked", () => {
    const html = buildStartPanelHtml(createStartPanelState());
    expect(html).toContain("GROUND STATION");
    expect(html).toContain("AIRBORNE");
    // The active class sits on the mode-btn class, before the data attribute.
    expect(html).toMatch(/class="mode-btn is-active"[^>]*data-mode="station"/);
  });

  it("marks airborne active when selected", () => {
    const html = buildStartPanelHtml({ ...createStartPanelState(), mode: "airborne" });
    expect(html).toMatch(/class="mode-btn is-active"[^>]*data-mode="airborne"/);
  });

  it("explains that the station role has no flight controls", () => {
    expect(buildStartPanelHtml(createStartPanelState())).toContain("No flight controls");
  });
});

describe("operator assistance", () => {
  it("defaults to manual, the scored training loop", () => {
    expect(createStartPanelState().assist).toBe("manual");
  });

  it("offers both assistance modes with labels and hints", () => {
    expect(ASSIST_MODES).toEqual(["manual", "assisted"]);
    for (const mode of ASSIST_MODES) {
      expect(ASSIST_LABEL[mode]).toBeTruthy();
      expect(ASSIST_HINT[mode]).toBeTruthy();
    }
  });

  it("renders both assistance buttons with manual active by default", () => {
    const html = buildStartPanelHtml(createStartPanelState());
    expect(html).toContain("Operator assistance");
    expect(html).toContain("MANUAL");
    expect(html).toContain("AI-ASSISTED");
    expect(html).toMatch(/class="mode-btn is-active"[^>]*data-assist="manual"/);
  });

  it("marks AI-assisted active when selected", () => {
    const html = buildStartPanelHtml({ ...createStartPanelState(), assist: "assisted" });
    expect(html).toMatch(/class="mode-btn is-active"[^>]*data-assist="assisted"/);
  });

  it("states that an assisted session is labelled and excluded from competency scoring", () => {
    const html = buildStartPanelHtml({ ...createStartPanelState(), assist: "assisted" });
    expect(html).toContain(`class="start-modehint is-assist-hint is-assisted"`);
    expect(html).toContain("excluded from competency scoring");
  });
});

describe("scenario source", () => {
  const options: ScriptedScenarioSummary[] = [
    {
      key: "first-contact-day", title: "First Contact", briefing: "Learn the loop.",
      difficulty: 1, environment: "rural", time_of_day: "day", threat_count: 1,
    },
    {
      key: "night-pair-degraded", title: "Night Pair", briefing: "Degraded sensors.",
      difficulty: 8, environment: "urban", time_of_day: "night", threat_count: 2,
    },
  ];

  it("defaults to procedural generation", () => {
    expect(createStartPanelState().source).toBe("procedural");
  });

  it("renders both source buttons with procedural active", () => {
    const html = buildStartPanelHtml(createStartPanelState());
    expect(html).toContain("PROCEDURAL");
    expect(html).toContain("SCRIPTED");
    expect(html).toMatch(/class="mode-btn is-active"[^>]*data-source="procedural"/);
  });

  it("shows a loading state while the fixture catalog loads", () => {
    const html = buildStartPanelHtml({ ...createStartPanelState(), source: "scripted" });
    expect(html).toContain("Loading scripted scenarios");
  });

  it("renders the fixture picker and selected briefing once loaded", () => {
    const html = buildStartPanelHtml({
      ...createStartPanelState(),
      source: "scripted",
      scriptedOptions: options,
      scenarioKey: "night-pair-degraded",
    });
    expect(html).toContain("night-pair-degraded");
    expect(html).toContain("Degraded sensors.");
    expect(html).not.toContain("Threat count");
  });

  it("surfaces a catalog load failure instead of failing silently", () => {
    const html = buildStartPanelHtml({
      ...createStartPanelState(),
      source: "scripted",
      scriptedOptions: [],
      scriptedError: "backend down",
    });
    expect(html).toContain("backend down");
  });

  it("keeps identity fields visible in scripted mode", () => {
    const html = buildStartPanelHtml({
      ...createStartPanelState(), source: "scripted", scriptedOptions: options,
    });
    expect(html).toContain('id="trainee_id"');
    expect(html).toContain('id="unit"');
  });

  it("resolveScenarioKey prefers the requested key and falls back to first", () => {
    expect(resolveScenarioKey(options, "night-pair-degraded")).toBe("night-pair-degraded");
    expect(resolveScenarioKey(options, "missing")).toBe("first-contact-day");
    expect(resolveScenarioKey(options, "")).toBe("first-contact-day");
    expect(resolveScenarioKey([], "")).toBe("");
  });
});

describe("minimumDifficulty", () => {
  it("matches the backend additive difficulty model", () => {
    // BASE(1) + threat + environment + time_of_day
    expect(minimumDifficulty("rural", "day", 1)).toBe(1);
    expect(minimumDifficulty("urban", "day", 1)).toBe(2);
    expect(minimumDifficulty("urban", "night", 1)).toBe(4);
    expect(minimumDifficulty("urban", "night", 5)).toBe(8);
    expect(minimumDifficulty("rural", "day", 5)).toBe(5);
  });

  it("costs +2 for night, which is what made the default form invalid", () => {
    const day = minimumDifficulty("urban", "day", 2);
    const night = minimumDifficulty("urban", "night", 2);
    expect(night - day).toBe(2);
    // The previous default of 3 was below the night floor for every combo
    // except a single rural contact.
    expect(minimumDifficulty("urban", "night", 2)).toBeGreaterThan(3);
  });
});

describe("parseStartForm", () => {
  const valid = {
    trainee_id: "TRAIN-001", environment: "rural", time_of_day: "day",
    threat_count: "2", difficulty: "4", seed: "",
  };

  it("accepts a reachable configuration", () => {
    const { request, error } = parseStartForm(valid);
    expect(error).toBeNull();
    expect(request.difficulty).toBe(4);
    expect(request.seed).toBeNull();
  });

  it("treats swarms as opt-in and off by default", () => {
    expect(parseStartForm(valid).request.swarms).toBe(false);
    expect(parseStartForm({ ...valid, swarms: "true" }).request.swarms).toBe(true);
    expect(parseStartForm({ ...valid, swarms: "on" }).request.swarms).toBe(true);
  });

  it("rejects a difficulty below the floor instead of sending a 422", () => {
    const { error } = parseStartForm({ ...valid, time_of_day: "night", environment: "urban", threat_count: "5", difficulty: "3" });
    expect(error).toContain("between 8 and 10");
  });

  it("rejects a blank difficulty that would previously become 0", () => {
    const { error, request } = parseStartForm({ ...valid, difficulty: "" });
    expect(error).not.toBeNull();
    expect(request.difficulty).toBeGreaterThanOrEqual(1);
  });

  it("rejects an out-of-range difficulty", () => {
    expect(parseStartForm({ ...valid, difficulty: "11" }).error).not.toBeNull();
    expect(parseStartForm({ ...valid, difficulty: "-4" }).error).not.toBeNull();
  });

  it("parses a numeric seed and treats blank as random", () => {
    expect(parseStartForm({ ...valid, seed: "42" }).request.seed).toBe(42);
    expect(parseStartForm({ ...valid, seed: "" }).request.seed).toBeNull();
    expect(parseStartForm({ ...valid, seed: "  " }).request.seed).toBeNull();
  });

  it("falls back to a trainee id when the field is blank", () => {
    expect(parseStartForm({ ...valid, trainee_id: "  " }).traineeId).toBe("TRAIN-001");
    expect(parseStartForm({ ...valid, trainee_id: "T9" }).traineeId).toBe("T9");
  });
});

describe("buildStartPanelHtml", () => {
  const state = createStartPanelState();

  it("shows the computed floor and current configuration", () => {
    const html = buildStartPanelHtml({ ...state, environment: "urban", timeOfDay: "night", threatCount: 5, difficulty: 8 });
    expect(html).toContain("floor 8");
    expect(html).toContain("URBAN / NIGHT");
    expect(html).toContain("5 contacts");
  });

  it("warns when the difficulty is below the floor", () => {
    const html = buildStartPanelHtml({ ...state, environment: "urban", timeOfDay: "night", threatCount: 2, difficulty: 3 });
    expect(html).toContain("is-warn");
    expect(html).toContain("below the minimum");
  });

  it("renders an error banner only when there is an error", () => {
    expect(buildStartPanelHtml({ ...state, error: null })).toContain("hidden");
    expect(buildStartPanelHtml({ ...state, error: "boom" })).toContain("boom");
  });

  it("renders the opt-in swarm checkbox, unchecked by default", () => {
    const html = buildStartPanelHtml(state);
    expect(html).toContain('id="swarms"');
    expect(html).toContain('name="swarms" type="checkbox"');
    expect(html).not.toContain('type="checkbox" checked');
    expect(buildStartPanelHtml({ ...state, swarms: true }))
      .toContain('type="checkbox" checked');
  });

  it("disables the submit button while busy", () => {
    expect(buildStartPanelHtml({ ...state, busy: true })).toContain("GENERATING");
    expect(buildStartPanelHtml({ ...state, busy: true })).toContain("disabled");
  });

  it("marks the selected options", () => {
    const html = buildStartPanelHtml({ ...state, environment: "rural" });
    expect(html).toMatch(/<option value="rural" selected>/);
  });

  it("defaults to a difficulty that works for the default scenario", () => {
    // Regression: the old default of 3 made most night configurations 422.
    expect(state.difficulty).toBeGreaterThanOrEqual(
      minimumDifficulty(state.environment, state.timeOfDay, state.threatCount),
    );
  });
});