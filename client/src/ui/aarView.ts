import type { AAR, PerformanceProfile, RecommendResponse } from "../api/types";
import { SCORING_MAXIMA } from "../api/types";

// Render helpers are pure string builders so they can be unit-tested under the
// node test environment, matching the pattern used elsewhere in this client.

// Nullable server fields must render as an em dash, never "NaN" or "null".
export function formatMetric(value: number | null, suffix = ""): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${Math.round(value)}${suffix}`;
}

export function formatSeconds(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "—";
  return `${(ms / 1000).toFixed(1)}s`;
}

export function scoreRows(aar: AAR): string {
  const s = aar.scores;
  const rows: Array<[string, number, number]> = [
    ["Detection", s.detection_score, SCORING_MAXIMA.detection],
    ["Classification", s.classification_score, SCORING_MAXIMA.classification],
    ["Response", s.response_score, SCORING_MAXIMA.response],
    ["Timing", s.timing_score, SCORING_MAXIMA.timing],
  ];
  return rows
    .map(([label, value, max]) => {
      const pct = max > 0 ? Math.round((value / max) * 100) : 0;
      return `<tr><td>${label}</td>`
        + `<td><span class="aar-bar"><span class="aar-bar-fill" style="width:${pct}%"></span></span></td>`
        + `<td class="aar-num">${value} / ${max}</td></tr>`;
    })
    .join("");
}

const MISTAKE_LABEL: Record<string, string> = {
  missed_threat: "Missed",
  false_alarm: "False alarm",
  classification_error: "Classification",
  response_error: "Response",
};

export function mistakeRows(aar: AAR): string {
  if (aar.mistakes.length === 0) {
    return `<tr><td colspan="3" class="aar-empty">No errors recorded.</td></tr>`;
  }
  return aar.mistakes
    .map((m) => {
      const label = MISTAKE_LABEL[m.kind] ?? m.kind;
      const at = (m.timestamp_ms / 1000).toFixed(1);
      const who = m.threat_id ?? "—";
      return `<tr><td>${at}s</td><td>${who}</td><td>${label}`
        + `${m.detail ? ` <span class="aar-detail">${m.detail}</span>` : ""}</td></tr>`;
    })
    .join("");
}

export function timingRows(aar: AAR): string {
  const t = aar.timing;
  const rows: Array<[string, number | null]> = [
    ["Spawn to detect", t.mean_time_to_detection_ms],
    ["Detect to classify", t.mean_detection_to_classification_ms],
    ["Classify to respond", t.mean_classification_to_response_ms],
    ["Total decision", t.mean_total_decision_ms],
  ];
  return rows
    .map(([label, value]) => `<tr><td>${label}</td><td class="aar-num">${formatSeconds(value)}</td></tr>`)
    .join("");
}

export function assessmentBlock(aar: AAR): string {
  const parts: string[] = [];
  if (aar.strengths.length > 0) {
    parts.push(`<div class="aar-list aar-good"><h4>Strengths</h4><ul>${
      aar.strengths.map((s) => `<li>${s}</li>`).join("")
    }</ul></div>`);
  }
  if (aar.weaknesses.length > 0) {
    parts.push(`<div class="aar-list aar-bad"><h4>Weaknesses</h4><ul>${
      aar.weaknesses.map((s) => `<li>${s}</li>`).join("")
    }</ul></div>`);
  }
  return parts.join("");
}

export function performanceBlock(profile: PerformanceProfile | null): string {
  if (!profile) return "";
  const conditions: Array<[string, number | null]> = [
    ["Day", profile.day_score],
    ["Night", profile.night_score],
    ["Multi-threat", profile.multi_threat_score],
    ["Urban", profile.urban_score],
    ["Rural", profile.rural_score],
    ["Clear vis", profile.clear_visibility_score],
    ["Poor vis", profile.poor_visibility_score],
  ];
  const cells = conditions
    .map(([label, value]) => `<div class="aar-cond"><span>${label}</span><b>${formatMetric(value)}</b></div>`)
    .join("");
  return `<div class="aar-conds">${cells}</div>`;
}

export function recommendationBlock(recommendation: RecommendResponse | null): string {
  if (!recommendation) return "";
  return `<div class="aar-next">
    <h4>Recommended next scenario</h4>
    <div class="aar-next-grid">
      <span>difficulty <b>${recommendation.recommended_difficulty}</b></span>
      <span>${recommendation.environment}</span>
      <span>${recommendation.time_of_day}</span>
      <span>${recommendation.threat_count} threat${recommendation.threat_count === 1 ? "" : "s"}</span>
    </div>
    <p class="aar-reason">${recommendation.reason}</p>
  </div>`;
}

export function buildAarHtml(
  aar: AAR,
  recommendation: RecommendResponse | null,
  profile: PerformanceProfile | null,
  loading: boolean,
): string {
  return `
    <h2>After Action Review</h2>
    ${loading ? `<p class="aar-loading">Loading server review…</p>` : ""}
    <div class="aar-grid">
      <section class="aar-card">
        <h3>Score</h3>
        <table class="aar-table">${scoreRows(aar)}</table>
        <div class="aar-final">
          <span>Penalty</span><span>-${aar.scores.penalty}</span>
          <span>Final</span><b>${aar.scores.final_score} / 100</b>
        </div>
        <p class="aar-meta">${aar.scenario_id} · scoring v${aar.scores.scoring_version}</p>
      </section>

      <section class="aar-card">
        <h3>Assessment</h3>
        <p class="aar-summary">${aar.summary}</p>
        ${assessmentBlock(aar)}
        <p class="aar-rec"><b>Focus:</b> ${aar.recommendation}</p>
      </section>

      <section class="aar-card">
        <h3>Timing</h3>
        <table class="aar-table">${timingRows(aar)}</table>
      </section>

      <section class="aar-card">
        <h3>Errors</h3>
        <table class="aar-table">
          <tr><th>time</th><th>contact</th><th>issue</th></tr>
          ${mistakeRows(aar)}
        </table>
      </section>
    </div>
    ${performanceBlock(profile)}
    ${recommendationBlock(recommendation)}
    <div class="aar-actions">
      <button id="again">Play again</button>
    </div>`;
}