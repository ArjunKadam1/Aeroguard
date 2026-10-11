import { describe, expect, it } from "vitest";
import type { AAR, PerformanceProfile, RecommendResponse } from "../api/types";
import {
  assessmentBlock,
  buildAarHtml,
  formatMetric,
  formatSeconds,
  mistakeRows,
  performanceBlock,
  recommendationBlock,
  scoreRows,
  timingRows,
} from "./aarView";

const aar: AAR = {
  session_id: "SES-1",
  scenario_id: "SCN-000042",
  summary: "Final score 85.0/100: detected 2/2.",
  scores: {
    session_id: "SES-1",
    detection_score: 30,
    classification_score: 24,
    response_score: 20,
    timing_score: 10,
    penalty: 5,
    final_score: 79,
    scoring_version: 1,
  },
  timing: {
    mean_time_to_detection_ms: 2400,
    mean_detection_to_classification_ms: null,
    mean_classification_to_response_ms: 1800,
    mean_total_decision_ms: null,
  },
  mistakes: [
    { kind: "missed_threat", timestamp_ms: 12400, threat_id: "T02", detail: "no detection recorded" },
    { kind: "false_alarm", timestamp_ms: 2000, threat_id: null, detail: "false alarm" },
  ],
  strengths: ["Detection: full marks."],
  weaknesses: ["Classification: lost 6.0 of 30."],
  recommendation: "Focus on classification in the next session.",
  timeline: [],
};

describe("nullable metrics", () => {
  it("renders an em dash rather than NaN or null", () => {
    expect(formatMetric(null)).toBe("—");
    expect(formatSeconds(null)).toBe("—");
  });

  it("renders finite values with the requested suffix", () => {
    expect(formatMetric(72.4)).toBe("72");
    expect(formatMetric(72.6, "%")).toBe("73%");
    expect(formatSeconds(2400)).toBe("2.4s");
  });

  it("treats non-finite values as missing", () => {
    expect(formatMetric(Number.NaN)).toBe("—");
    expect(formatMetric(Number.POSITIVE_INFINITY)).toBe("—");
  });

  it("shows an em dash for unmeasured timing metrics", () => {
    const html = timingRows(aar);
    expect(html).toContain("2.4s");
    expect(html).toContain("—");
    expect(html).not.toContain("NaN");
    expect(html).not.toContain("null");
  });
});

describe("score rows", () => {
  it("uses the shared scoring maxima and renders bars", () => {
    const html = scoreRows(aar);
    expect(html).toContain("30 / 30");
    expect(html).toContain("24 / 30");
    expect(html).toContain("20 / 25");
    expect(html).toContain("10 / 15");
    expect(html).toContain("aar-bar-fill");
  });
});

describe("mistakes", () => {
  it("lists each error with its time and contact", () => {
    const html = mistakeRows(aar);
    expect(html).toContain("12.4s");
    expect(html).toContain("T02");
    expect(html).toContain("Missed");
    expect(html).toContain("False alarm");
  });

  it("shows an explicit empty state when nothing went wrong", () => {
    const clean: AAR = { ...aar, mistakes: [] };
    expect(mistakeRows(clean)).toContain("No errors recorded");
  });

  it("shows a dash for a mistake with no threat id", () => {
    const html = mistakeRows(aar);
    expect(html).toContain("—");
  });
});

describe("performance and recommendation", () => {
  const profile: PerformanceProfile = {
    trainee_id: "T1", session_count: 4,
    detection_accuracy: 100, classification_accuracy: 80, response_accuracy: 75,
    average_reaction_time_ms: 2100,
    night_score: 58, day_score: 91, multi_threat_score: 66,
    low_visibility_score: null, urban_score: 84, rural_score: null,
    clear_visibility_score: 95, reduced_visibility_score: null, poor_visibility_score: null,
    high_sensor_score: null, medium_sensor_score: 80, low_sensor_score: null,
    current_level: 4,
  };

  it("renders condition metrics and marks unseen conditions with a dash", () => {
    const html = performanceBlock(profile);
    expect(html).toContain("Night");
    expect(html).toContain("58");
    expect(html).toContain("—");
    expect(html).not.toContain("NaN");
  });

  it("returns nothing when there is no profile", () => {
    expect(performanceBlock(null)).toBe("");
  });

  it("renders the adaptive recommendation with its metric-cited reason", () => {
    const rec: RecommendResponse = {
      recommended_difficulty: 7,
      environment: "urban",
      time_of_day: "night",
      threat_count: 3,
      reason: "Night score 58.0 is 15.0 points below overall 73.0",
    };
    const html = recommendationBlock(rec);
    expect(html).toContain("7");
    expect(html).toContain("urban");
    expect(html).toContain("3 threats");
    expect(html).toContain("15.0 points below");
  });

  it("singularises a one-threat recommendation", () => {
    const rec: RecommendResponse = {
      recommended_difficulty: 3, environment: "rural", time_of_day: "day",
      threat_count: 1, reason: "hold",
    };
    expect(recommendationBlock(rec)).toContain("1 threat<");
  });

  it("lists strengths and weaknesses", () => {
    const html = assessmentBlock(aar);
    expect(html).toContain("Detection: full marks.");
    expect(html).toContain("lost 6.0 of 30");
  });
});

describe("buildAarHtml", () => {
  it("renders the server narrative and score", () => {
    const html = buildAarHtml(aar, null, null, false);
    expect(html).toContain("Final score 85.0/100");
    expect(html).toContain("79");
    expect(html).toContain("SCN-000042");
    expect(html).toContain("Play again");
  });

  it("shows a loading state before the server review arrives", () => {
    expect(buildAarHtml(aar, null, null, true)).toContain("Loading server review");
  });
});