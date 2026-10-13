import { describe, expect, it } from "vitest";
import type { AAR, EventCreateRequest, PerformanceProfile, RecommendResponse } from "../api/types";
import {
  assessmentBlock,
  barClass,
  buildAarHtml,
  errorBanner,
  formatMetric,
  formatSeconds,
  groundTruthBlock,
  mistakeCounts,
  mistakeRows,
  mistakeSummary,
  performanceBlock,
  performanceStats,
  recommendationBlock,
  scoreHero,
  scoreRows,
  timelineBlock,
  timelineRows,
  timingRows,
  verdictFor,
} from "./aarView";

const timeline: EventCreateRequest[] = [
  { type: "SESSION_STARTED", timestamp_ms: 0, threat_id: null, payload: {} },
  { type: "THREAT_SPAWNED", timestamp_ms: 4000, threat_id: "T01", payload: {} },
  { type: "THREAT_DETECTED", timestamp_ms: 5200, threat_id: "T01", payload: {} },
  { type: "CLASSIFICATION_SUBMITTED", timestamp_ms: 6100, threat_id: "T01", payload: { label: "hostile" } },
  { type: "RESPONSE_SUBMITTED", timestamp_ms: 7400, threat_id: "T01", payload: { response: "hold" } },
];

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
    penalty: 0,
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
  timeline,
  ground_truth: [
    { threat_id: "T01", classification_label: "hostile", expected_response: "hold" },
    { threat_id: "T02", classification_label: "civilian", expected_response: "monitor" },
  ],
};

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

describe("verdict and hero score", () => {
  it("bands the score the way the narrative engine reasons", () => {
    expect(verdictFor(95)).toBe("exemplary");
    expect(verdictFor(90)).toBe("exemplary");
    expect(verdictFor(79)).toBe("satisfactory");
    expect(verdictFor(65)).toBe("marginal");
    expect(verdictFor(30)).toBe("unsatisfactory");
  });

  it("renders the score as the dominant element", () => {
    const html = scoreHero(aar, null);
    expect(html).toContain("aar-hero-score");
    expect(html).toContain("79");
    expect(html).toContain("SATISFACTORY");
  });

  it("never renders a negative zero penalty", () => {
    const html = scoreHero(aar, null);
    expect(html).not.toContain("-0");
    expect(html).toContain("no penalty");
  });

  it("shows a real penalty when one was incurred", () => {
    const penalised: AAR = { ...aar, scores: { ...aar.scores, penalty: 5 } };
    expect(scoreHero(penalised, null)).toContain("penalty -5");
  });

  it("includes the session header when supplied", () => {
    const html = scoreHero(aar, {
      scenarioId: "SCN-000042", environment: "urban", timeOfDay: "night",
      difficulty: 6, durationSeconds: 150, threatCount: 2, unit: null,
    });
    expect(html).toContain("URBAN / NIGHT");
    expect(html).toContain("difficulty 6");
    expect(html).toContain("2 contacts");
    expect(html).toContain("2:30");
  });
});

describe("score bars", () => {
  it("grades bars green, amber or red by fraction earned", () => {
    expect(barClass(30, 30)).toBe("is-good");
    expect(barClass(24, 30)).toBe("is-warn");
    expect(barClass(8, 30)).toBe("is-bad");
  });

  it("handles a zero maximum safely", () => {
    expect(barClass(5, 0)).toBe("is-bad");
  });

  it("marks each bar with its grade", () => {
    expect(scoreRows(aar)).toContain("is-good");
  });
});

describe("timeline", () => {
  it("renders every recorded event", () => {
    const html = timelineRows(timeline);
    for (const label of ["Session start", "Contact appeared", "Detected", "Classified", "Response chosen"]) {
      expect(html).toContain(label);
    }
  });

  it("shows the trainee's actual decisions", () => {
    const html = timelineRows(timeline);
    expect(html).toContain("hostile");
    expect(html).toContain("hold");
  });

  it("shows sensor provenance on detection events", () => {
    const html = timelineRows([
      {
        type: "THREAT_DETECTED" as const, timestamp_ms: 1000, threat_id: "T01",
        payload: { observer: "scout", sensor: "radar" },
      },
    ]);
    expect(html).toContain("scout · radar");
  });

  it("shows when the contact first entered the sensor picture", () => {
    const html = timelineRows([
      {
        type: "THREAT_DETECTED" as const, timestamp_ms: 5000, threat_id: "T01",
        payload: { observer: "station", sensor: "visual", first_seen_ms: 2300 },
      },
    ]);
    expect(html).toContain("station · visual · first seen 2.3s");
  });

  it("orders events by timestamp even if given out of order", () => {
    const shuffled = [timeline[4], timeline[0], timeline[2]];
    const html = timelineRows(shuffled);
    expect(html.indexOf("Session start")).toBeLessThan(html.indexOf("Detected"));
    expect(html.indexOf("Detected")).toBeLessThan(html.indexOf("Response chosen"));
  });

  it("shows an empty state when no events were recorded", () => {
    expect(timelineRows([])).toContain("No events recorded");
  });

  it("marks errors distinctly", () => {
    const withError = [...timeline, { type: "FALSE_ALARM" as const, timestamp_ms: 9000, threat_id: null, payload: {} }];
    expect(timelineRows(withError)).toContain("ev-error");
  });

  it("wraps the timeline in its own card", () => {
    expect(timelineBlock(aar)).toContain("Timeline");
  });
});

describe("ground truth reveal", () => {
  it("lists every contact's answers after the session", () => {
    const html = groundTruthBlock(aar);
    expect(html).toContain("Ground truth");
    expect(html).toContain("T01");
    expect(html).toContain("hostile");
    expect(html).toContain("hold");
    expect(html).toContain("T02");
    expect(html).toContain("civilian");
  });

  it("renders nothing when the server sent no reveal", () => {
    expect(groundTruthBlock({ ...aar, ground_truth: [] })).toBe("");
  });
});

describe("error reporting", () => {
  it("summarises mistake counts by kind", () => {
    expect(mistakeSummary(aar.mistakes)).toBe("1 missed contact · 1 false alarm");
    expect(mistakeCounts(aar.mistakes)).toHaveLength(2);
  });

  it("pluralises repeated mistakes", () => {
    const many: AAR["mistakes"] = [
      { kind: "missed_threat", timestamp_ms: 1, threat_id: "T01", detail: null },
      { kind: "missed_threat", timestamp_ms: 2, threat_id: "T02", detail: null },
    ];
    expect(mistakeSummary(many)).toBe("2 missed contacts");
  });

  it("renders nothing to summarise on a clean run", () => {
    expect(mistakeSummary([])).toBe("");
  });

  it("shows a banner listing what failed to load", () => {
    const html = errorBanner(["Review: 500", "Performance history: timeout"]);
    expect(html).toContain("could not be loaded");
    expect(html).toContain("Review: 500");
    expect(html).toContain("Performance history: timeout");
  });

  it("renders no banner when nothing failed", () => {
    expect(errorBanner([])).toBe("");
  });
});

describe("cumulative performance", () => {
  it("shows the fields that were previously fetched and discarded", () => {
    const html = performanceStats(profile);
    expect(html).toContain("Sessions");
    expect(html).toContain("Adaptive level");
    expect(html).toContain("4");
    expect(html).toContain("100%");
    expect(html).toContain("2.1s");
  });

  it("marks unseen conditions with an em dash, never NaN", () => {
    const html = performanceBlock(profile);
    expect(html).toContain("—");
    expect(html).not.toContain("NaN");
  });

  it("groups conditions the way the backend computes them", () => {
    const html = performanceBlock(profile);
    for (const group of ["Environment", "Time", "Visibility", "Sensor", "Contacts"]) {
      expect(html).toContain(group);
    }
  });

  it("returns nothing without a profile", () => {
    expect(performanceBlock(null)).toBe("");
  });
});

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
    expect(html).toContain("Missed contact");
    expect(html).toContain("False alarm");
  });

  it("shows an explicit empty state when nothing went wrong", () => {
    const clean: AAR = { ...aar, mistakes: [] };
    expect(mistakeRows(clean)).toContain("No errors recorded");
  });

  it("shows a dash for a mistake with no threat id", () => {
    expect(mistakeRows(aar)).toContain("—");
  });
});

describe("assessment and recommendation", () => {
  it("lists strengths and weaknesses", () => {
    const html = assessmentBlock(aar);
    expect(html).toContain("Detection: full marks.");
    expect(html).toContain("lost 6.0 of 30");
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

  it("returns nothing without a recommendation", () => {
    expect(recommendationBlock(null)).toBe("");
  });
});

describe("buildAarHtml", () => {
  it("renders the narrative, hero score and timeline", () => {
    const html = buildAarHtml(aar, null, null, false);
    expect(html).toContain("Final score 85.0/100");
    expect(html).toContain("aar-hero-score");
    expect(html).toContain("Timeline");
    expect(html).toContain("Play again");
  });

  it("shows a loading state before the server review arrives", () => {
    expect(buildAarHtml(aar, null, null, true)).toContain("Loading full review");
  });

  it("surfaces load failures", () => {
    expect(buildAarHtml(aar, null, null, false, null, ["Review: 500"])).toContain("Review: 500");
  });
});