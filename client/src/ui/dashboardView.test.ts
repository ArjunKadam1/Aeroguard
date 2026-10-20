import { describe, expect, it } from "vitest";
import type {
  PerformanceProfile, SessionHistoryItem, UnitPerformance,
} from "../api/types";
import {
  buildDashboardHtml,
  profileSummaryBlock,
  sessionHistoryRows,
  trendPoints,
  trendSparkline,
  unitSummaryBlock,
} from "./dashboardView";

function item(over: Partial<SessionHistoryItem> = {}): SessionHistoryItem {
  return {
    session_id: "SES-1",
    scenario_id: "SCN-000001",
    unit: "ALPHA-1",
    completed_at: "2026-05-01T10:15:00",
    final_score: 78,
    environment: "urban",
    time_of_day: "day",
    difficulty: 4,
    threat_count: 2,
    ...over,
  };
}

const history: SessionHistoryItem[] = [
  item({ final_score: 91, scenario_id: "SCN-3" }),
  item({ final_score: 62, scenario_id: "SCN-2" }),
  item({ final_score: 80, scenario_id: "SCN-1" }),
];

const unit: UnitPerformance = {
  unit: "ALPHA-1", session_count: 12, trainee_count: 4,
  mean_final_score: 74.5, best_final_score: 96,
  detection_accuracy: 88, classification_accuracy: 71, response_accuracy: 69,
  average_reaction_time_ms: 2400, mean_timing_score: 8.5,
  weaknesses: [
    { condition: "Night", score: 52, gap: 22.5 },
    { condition: "Multi-threat", score: 60, gap: 14.5 },
  ],
};

const profile: PerformanceProfile = {
  trainee_id: "T1", session_count: 3,
  detection_accuracy: 100, classification_accuracy: 80, response_accuracy: 75,
  average_reaction_time_ms: 2100,
  night_score: 58, day_score: 91, multi_threat_score: 66,
  low_visibility_score: null, urban_score: 84, rural_score: null,
  clear_visibility_score: 95, reduced_visibility_score: null, poor_visibility_score: null,
  high_sensor_score: null, medium_sensor_score: 80, low_sensor_score: null,
  current_level: 4,
};

describe("trend sparkline", () => {
  it("plots oldest first even though history arrives newest first", () => {
    const points = trendPoints(history);
    expect(points.map((p) => p.y)).toEqual([80, 62, 91]);
  });

  it("renders an svg path and one dot per session", () => {
    const svg = trendSparkline(history);
    expect(svg).toContain("<svg");
    expect(svg).toContain("dash-line");
    expect((svg.match(/dash-dot/g) ?? []).length).toBe(3);
  });

  it("handles a single session without dividing by zero", () => {
    const svg = trendSparkline([item()]);
    expect(svg).not.toContain("NaN");
    expect(svg).toContain("dash-line");
  });

  it("shows an empty state with no sessions", () => {
    expect(trendSparkline([])).toContain("No completed sessions");
  });

  it("never emits NaN for extreme scores", () => {
    const svg = trendSparkline([item({ final_score: 0 }), item({ final_score: 100 })]);
    expect(svg).not.toContain("NaN");
  });
});

describe("session history", () => {
  it("lists every session with its score", () => {
    const rows = sessionHistoryRows(history);
    expect(rows).toContain("SCN-1");
    expect(rows).toContain("91");
    expect(rows).toContain("URBAN / DAY");
  });

  it("shows an empty state when there is no history", () => {
    expect(sessionHistoryRows([])).toContain("No completed sessions");
  });

  it("renders a dash when the completion time is unknown", () => {
    expect(sessionHistoryRows([item({ completed_at: null })])).toContain("—");
  });

  it("badges assisted sessions in the history", () => {
    const rows = sessionHistoryRows([item({ ai_assisted: true })]);
    expect(rows).toContain("ASSISTED");
    expect(sessionHistoryRows([item()])).not.toContain("ASSISTED");
  });
});

describe("assisted session exclusion", () => {
  const mixed = [
    item({ final_score: 99, scenario_id: "SCN-ASSISTED", ai_assisted: true }),
    item({ final_score: 80, scenario_id: "SCN-1" }),
    item({ final_score: 70, scenario_id: "SCN-2" }),
  ];

  it("keeps assisted sessions out of the score headline", () => {
    const html = buildDashboardHtml("T1", null, mixed, null, null, false, []);
    // Latest/Sessions describe the two competency sessions: the assisted 99
    // must not become the headline even though its row is listed below.
    expect(html).toContain("<span>Latest</span><b>80</b>");
    expect(html).toContain("<span>Sessions</span><b>2</b>");
    expect(html).not.toContain("<span>Latest</span><b>99</b>");
  });

  it("keeps assisted sessions out of the score trend but in the history table", () => {
    const html = buildDashboardHtml("T1", null, mixed, null, null, false, []);
    expect((html.match(/dash-dot/g) ?? []).length).toBe(2);
    expect(html).toContain("SCN-ASSISTED");
    expect(html).toContain("ASSISTED");
    expect(html).toContain("1 AI-assisted session labelled and excluded");
  });

  it("leaves a manual dashboard untouched", () => {
    const html = buildDashboardHtml("T1", null, history, null, null, false, []);
    expect(html).not.toContain("AI-assisted");
    expect(html).toContain(">91<");
  });

  it("shows an empty scored state when every session was assisted", () => {
    const html = buildDashboardHtml("T1", null, [
      item({ final_score: 99, ai_assisted: true, scenario_id: "SCN-ASSISTED" }),
    ], null, null, false, []);
    expect(html).toContain("No scored sessions yet");
    expect(html).toContain("SCN-ASSISTED");
    expect(html).toContain("ASSISTED");
    expect(html).toContain("<span>Sessions</span><b>0</b>");
    expect(html).toContain("<span>Best</span><b>—</b>");
  });
});

describe("unit rollup", () => {
  it("summarises sessions, trainees and accuracies", () => {
    const html = unitSummaryBlock(unit);
    expect(html).toContain("Sessions");
    expect(html).toContain("Trainees");
    // 74.5 rounds to 75 with Math.round.
    expect(html).toContain(">75<");
    expect(html).toContain("88%");
  });

  it("ranks weaknesses and states the gap", () => {
    const html = unitSummaryBlock(unit);
    expect(html).toContain("Night");
    expect(html).toContain("trails by 23");
  });

  it("says so when no condition trails the mean", () => {
    expect(unitSummaryBlock({ ...unit, weaknesses: [] })).toContain("No condition trails");
  });

  it("returns nothing without a unit", () => {
    expect(unitSummaryBlock(null)).toBe("");
  });
});

describe("profile summary", () => {
  it("shows the adaptive level and accuracies", () => {
    const html = profileSummaryBlock(profile);
    expect(html).toContain("Adaptive level");
    expect(html).toContain("100%");
  });

  it("returns nothing without a profile", () => {
    expect(profileSummaryBlock(null)).toBe("");
  });
});

describe("buildDashboardHtml", () => {
  it("renders the headline, trend, history and back button", () => {
    const html = buildDashboardHtml("T1", "ALPHA-1", history, profile, unit, false, []);
    expect(html).toContain("Performance");
    expect(html).toContain("T1");
    expect(html).toContain("ALPHA-1");
    expect(html).toContain("Score trend");
    expect(html).toContain("Session history");
    expect(html).toContain("Unit weaknesses");
    expect(html).toContain("dash-back");
  });

  it("computes mean, best and latest from history", () => {
    const html = buildDashboardHtml("T1", null, history, null, null, false, []);
    expect(html).toContain("Latest");
    expect(html).toContain("Mean");
    // (91 + 62 + 80) / 3 = 77.67 -> 78
    expect(html).toContain(">78<");
  });

  it("shows a loading state before data arrives", () => {
    expect(buildDashboardHtml("T1", null, [], null, null, true, []))
      .toContain("Loading performance history");
  });

  it("surfaces load failures", () => {
    const html = buildDashboardHtml("T1", null, [], null, null, false, ["History: 500"]);
    expect(html).toContain("History: 500");
  });

  it("copes with a trainee who has never flown", () => {
    const html = buildDashboardHtml("NEW", null, [], null, null, false, []);
    expect(html).toContain("No completed sessions");
    expect(html).not.toContain("NaN");
  });
});