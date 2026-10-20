import type {
  PerformanceProfile, SessionHistoryItem, UnitPerformance,
} from "../api/types";
import { verdictFor } from "./aarView";

// Pure render builders for the performance dashboard, so they can be unit-tested
// under the node test environment like aarView.ts and cockpit.ts.

function metric(value: number | null, suffix = ""): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${Math.round(value)}${suffix}`;
}

function seconds(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "—";
  return `${(ms / 1000).toFixed(1)}s`;
}

function gradeClass(value: number, max = 100): string {
  if (max <= 0) return "is-bad";
  const pct = value / max;
  if (pct >= 0.85) return "is-good";
  if (pct >= 0.6) return "is-warn";
  return "is-bad";
}

// ---------------------------------------------------------------------------
// Trend sparkline
// ---------------------------------------------------------------------------

export interface TrendPoint {
  x: number;
  y: number;
}

// History arrives newest-first; a left-to-right trend reads better oldest-first.
export function trendPoints(history: SessionHistoryItem[]): TrendPoint[] {
  return [...history]
    .reverse()
    .map((item, index) => ({ x: index, y: item.final_score }));
}

// Inline SVG sparkline over the 0-100 score range.
export function trendSparkline(history: SessionHistoryItem[], width = 320, height = 64): string {
  const points = trendPoints(history);
  if (points.length === 0) {
    return `<div class="dash-empty">No completed sessions yet.</div>`;
  }
  const pad = 6;
  const innerW = width - pad * 2;
  const innerH = height - pad * 2;
  const stepX = points.length > 1 ? innerW / (points.length - 1) : 0;
  const toY = (score: number) => pad + innerH * (1 - Math.max(0, Math.min(100, score)) / 100);
  const coords = points.map((p, i) => [pad + i * stepX, toY(p.y)] as const);
  const path = coords.map(([x, y], i) => `${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  const dots = coords
    .map(([x, y], i) =>
      `<circle class="dash-dot ${gradeClass(points[i].y)}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3"/>`)
    .join("");
  return `<svg class="dash-spark" viewBox="0 0 ${width} ${height}" width="100%" height="${height}"
       role="img" aria-label="score trend across ${points.length} sessions">
    <line x1="${pad}" y1="${toY(0)}" x2="${width - pad}" y2="${toY(0)}" class="dash-axis"/>
    <line x1="${pad}" y1="${toY(50)}" x2="${width - pad}" y2="${toY(50)}" class="dash-axis"/>
    <line x1="${pad}" y1="${toY(100)}" x2="${width - pad}" y2="${toY(100)}" class="dash-axis"/>
    <path d="${path}" class="dash-line"/>
    ${dots}
  </svg>`;
}

// ---------------------------------------------------------------------------
// Session history
// ---------------------------------------------------------------------------

export function sessionHistoryRows(history: SessionHistoryItem[]): string {
  if (history.length === 0) {
    return `<tr><td colspan="6" class="aar-empty">No completed sessions yet.</td></tr>`;
  }
  return history
    .map((item) => {
      const verdict = verdictFor(item.final_score);
      const when = item.completed_at ? item.completed_at.slice(0, 16).replace("T", " ") : "—";
      // AI-assisted sessions stay visible in the trainee's own history, but the
      // badge makes clear the score describes the assistant's run.
      const badge = item.ai_assisted
        ? ` <span class="dash-chip is-assisted">ASSISTED</span>`
        : "";
      return `<tr>
        <td class="aar-num">${when}</td>
        <td>${item.scenario_id}${badge}</td>
        <td>${item.environment.toUpperCase()} / ${item.time_of_day.toUpperCase()}</td>
        <td class="aar-num">${item.difficulty}</td>
        <td class="aar-num">${item.threat_count}</td>
        <td class="aar-num"><span class="aar-verdict is-${verdict}">${item.final_score}</span></td>
      </tr>`;
    })
    .join("");
}

// ---------------------------------------------------------------------------
// Unit rollup
// ---------------------------------------------------------------------------

export function unitSummaryBlock(unit: UnitPerformance | null): string {
  if (!unit) return "";
  const tiles: Array<[string, string]> = [
    ["Sessions", String(unit.session_count)],
    ["Trainees", String(unit.trainee_count)],
    ["Mean score", metric(unit.mean_final_score)],
    ["Best", metric(unit.best_final_score)],
    ["Detection", metric(unit.detection_accuracy, "%")],
    ["Classification", metric(unit.classification_accuracy, "%")],
    ["Response", metric(unit.response_accuracy, "%")],
    ["Avg reaction", seconds(unit.average_reaction_time_ms)],
  ];
  const cells = tiles
    .map(([label, value]) =>
      `<div class="aar-stat"><span>${label}</span><b>${value}</b></div>`)
    .join("");
  const weaknesses = unit.weaknesses.length === 0
    ? `<p class="aar-empty">No condition trails the unit mean.</p>`
    : `<ul class="dash-weaknesses">${unit.weaknesses
        .map((w) =>
          `<li><span>${w.condition}</span><b>${Math.round(w.score)}</b>`
          + `<em>trails by ${Math.round(w.gap)}</em></li>`)
        .join("")}</ul>`;
  return `<div class="aar-stats">${cells}</div>
    <h4 class="dash-subhead">Unit weaknesses</h4>
    ${weaknesses}`;
}

export function profileSummaryBlock(profile: PerformanceProfile | null): string {
  if (!profile) return "";
  const tiles: Array<[string, string]> = [
    ["Sessions", String(profile.session_count)],
    ["Adaptive level", String(profile.current_level)],
    ["Detection", metric(profile.detection_accuracy, "%")],
    ["Classification", metric(profile.classification_accuracy, "%")],
    ["Response", metric(profile.response_accuracy, "%")],
    ["Avg reaction", seconds(profile.average_reaction_time_ms)],
  ];
  return `<div class="aar-stats">${tiles
    .map(([label, value]) =>
      `<div class="aar-stat"><span>${label}</span><b>${value}</b></div>`)
    .join("")}</div>`;
}

export function buildDashboardHtml(
  traineeId: string,
  unit: string | null,
  history: SessionHistoryItem[],
  profile: PerformanceProfile | null,
  unitPerformance: UnitPerformance | null,
  loading: boolean,
  errors: string[],
): string {
  // Score headline and trend cover scored sessions only: assisted sessions
  // are excluded from competency rollups server-side, so the dashboard's own
  // numbers must agree. They remain listed in the history table below with
  // their ASSISTED badge.
  const scored = history.filter((item) => !item.ai_assisted);
  const assistedCount = history.length - scored.length;
  const latest = scored[0];
  const best = scored.length === 0
    ? null
    : scored.reduce((acc, item) => (item.final_score > acc ? item.final_score : acc), 0);
  const mean = scored.length === 0
    ? null
    : scored.reduce((sum, item) => sum + item.final_score, 0) / scored.length;
  const headline: Array<[string, string]> = [
    ["Latest", latest ? String(latest.final_score) : "—"],
    ["Mean", metric(mean)],
    ["Best", best === null ? "—" : String(best)],
    ["Sessions", String(scored.length)],
  ];
  return `
    <h2>Performance</h2>
    <p class="dash-subject">Trainee <b>${traineeId}</b>${unit ? ` · Unit <b>${unit}</b>` : ""}</p>
    ${errors.length > 0
      ? `<div class="aar-error" role="alert"><strong>Some data could not be loaded.</strong>
         <ul>${errors.map((e) => `<li>${e}</li>`).join("")}</ul></div>`
      : ""}
    ${loading ? `<p class="aar-loading">Loading performance history…</p>` : ""}
    <div class="aar-stats dash-headline">${headline
      .map(([label, value]) =>
        `<div class="aar-stat"><span>${label}</span><b>${value}</b></div>`)
      .join("")}</div>

    <section class="aar-card dash-trend">
      <h3>Score trend</h3>
      ${scored.length === 0 && history.length > 0
        ? `<div class="dash-empty">No scored sessions yet.</div>`
        : trendSparkline(scored)}
    </section>

    <section class="aar-card">
      <h3>Session history</h3>
      <table class="aar-table">
        <tr><th>completed</th><th>scenario</th><th>environment</th>
            <th>diff</th><th>contacts</th><th>score</th></tr>
        ${sessionHistoryRows(history)}
      </table>
      ${assistedCount > 0
        ? `<p class="aar-meta">${assistedCount} AI-assisted session${
          assistedCount === 1 ? "" : "s"
        } labelled and excluded from the score trend and rollups.</p>`
        : ""}
    </section>

    ${unitSummaryBlock(unitPerformance)}

    <section class="aar-card">
      <h3>Accuracy record</h3>
      ${profileSummaryBlock(profile)}
    </section>

    <div class="aar-actions">
      <button id="dash-back">Back</button>
    </div>`;
}