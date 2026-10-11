import { describe, expect, it } from "vitest";
import {
  buildStartPanelHtml,
  createStartPanelState,
  minimumDifficulty,
  parseStartForm,
} from "./startPanel";

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