import type {
  AAR, EventCreateRequest, PerformanceProfile, RecommendResponse,
} from "../api/types";
import { SCORING_MAXIMA } from "../api/types";

// Render helpers are pure string builders so they can be unit-tested under the
// node test environment, matching the pattern used elsewhere in this client.

// ---------------------------------------------------------------------------
// Verdict + hero score
// ---------------------------------------------------------------------------

export type Verdict = "exemplary" | "satisfactory" | "marginal" | "unsatisfactory";

// Bands follow the same thresholds the narrative/adaptive engine reasons about
// (90+ is consistently strong, below 60 is consistently weak).
export function verdictFor(score: number): Verdict {
  if (score >= 90) return "exemplary";
  if (score >= 75) return "satisfactory";
  if (score >= 60) return "marginal";
  return "unsatisfactory";
}

const VERDICT_LABEL: Record<Verdict, string> = {
  exemplary: "EXEMPLARY",
  satisfactory: "SATISFACTORY",
  marginal: "MARGINAL",
  unsatisfactory: "UNSATISFACTORY",
};

export function scoreHero(aar: AAR, header: SessionHeader | null): string {
  const score = aar.scores.final_score;
  const verdict = verdictFor(score);
  // A clean run must not render "-0"; only show a penalty when there is one.
  const penalty = aar.scores.penalty;
  const penaltyText = penalty > 0 ? `-${penalty}` : "0";
  return `<header class="aar-hero">
    <div class="aar-hero-main">
      <div class="aar-hero-score">${score}</div>
      <div class="aar-hero-meta">
        <span class="aar-verdict is-${verdict}">${VERDICT_LABEL[verdict]}</span>
        <span class="aar-hero-sub">out of 100</span>
      </div>
    </div>
    <div class="aar-hero-side">
      ${header ? sessionHeaderHtml(header) : ""}
      <div class="aar-hero-penalty">${penaltyText === "0" ? "no penalty" : `penalty ${penaltyText}`}</div>
    </div>
  </header>`;
}

export interface SessionHeader {
  scenarioId: string;
  environment: string;
  timeOfDay: string;
  difficulty: number;
  durationSeconds: number;
  threatCount: number;
  unit: string | null;
}

function sessionHeaderHtml(header: SessionHeader): string {
  const minutes = Math.floor(header.durationSeconds / 60);
  const seconds = Math.round(header.durationSeconds % 60);
  const clock = `${minutes}:${String(seconds).padStart(2, "0")}`;
  return `<div class="aar-session">
    <span class="aar-session-id">${header.scenarioId}</span>
    <span>${header.environment.toUpperCase()} / ${header.timeOfDay.toUpperCase()}</span>
    <span>difficulty ${header.difficulty}</span>
    <span>${header.threatCount} contact${header.threatCount === 1 ? "" : "s"}</span>
    <span>${clock}</span>
  </div>`;
}

// ---------------------------------------------------------------------------
// Score breakdown
// ---------------------------------------------------------------------------

// Green at full marks, amber when most points were earned, red when most were
// lost. Every bar previously used the same blue, so 30/30 and 0/30 looked alike.
export function barClass(value: number, max: number): string {
  if (max <= 0) return "is-bad";
  const pct = value / max;
  if (pct >= 0.85) return "is-good";
  if (pct >= 0.5) return "is-warn";
  return "is-bad";
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
        + `<td><span class="aar-bar"><span class="aar-bar-fill ${barClass(value, max)}" `
        + `style="width:${pct}%"></span></span></td>`
        + `<td class="aar-num">${value} / ${max}</td></tr>`;
    })
    .join("");
}

// ---------------------------------------------------------------------------
// Timeline -- the payload has always been fetched and never rendered, despite
// being rank 4 in the project's own AAR hierarchy (docs/modules/ui_ux.md §7).
// ---------------------------------------------------------------------------

const EVENT_LABEL: Record<string, string> = {
  SESSION_STARTED: "Session start",
  SCENARIO_LOADED: "Scenario loaded",
  THREAT_SPAWNED: "Contact appeared",
  THREAT_DETECTED: "Detected",
  CLASSIFICATION_SUBMITTED: "Classified",
  RESPONSE_SUBMITTED: "Response chosen",
  THREAT_RESOLVED: "Contact resolved",
  FALSE_ALARM: "False alarm",
  THREAT_MISSED: "Contact missed",
  SESSION_COMPLETED: "Session complete",
};

const EVENT_CLASS: Record<string, string> = {
  SESSION_STARTED: "ev-session",
  SCENARIO_LOADED: "ev-session",
  THREAT_SPAWNED: "ev-spawn",
  THREAT_DETECTED: "ev-detect",
  CLASSIFICATION_SUBMITTED: "ev-classify",
  RESPONSE_SUBMITTED: "ev-respond",
  THREAT_RESOLVED: "ev-responded",
  FALSE_ALARM: "ev-error",
  THREAT_MISSED: "ev-error",
  SESSION_COMPLETED: "ev-session",
};

// Decision payloads carry what the trainee actually chose, which is the only
// place the AAR shows expected-vs-chosen side by side. Detection events carry
// sensor provenance (observer/sensor) plus when the contact first entered the
// sensor picture -- the observable-vs-action comparison.
function decisionDetail(event: EventCreateRequest): string {
  const payload = event.payload ?? {};
  if (typeof payload.label === "string") return payload.label;
  if (typeof payload.response === "string") return payload.response;
  if (typeof payload.sensor === "string") {
    const observer = typeof payload.observer === "string" ? `${payload.observer} · ` : "";
    const seen = typeof payload.first_seen_ms === "number"
      ? ` · first seen ${(payload.first_seen_ms / 1000).toFixed(1)}s`
      : "";
    return `${observer}${payload.sensor}${seen}`;
  }
  return "";
}

export function timelineRows(events: EventCreateRequest[]): string {
  if (events.length === 0) {
    return `<tr><td colspan="4" class="aar-empty">No events recorded.</td></tr>`;
  }
  const ordered = [...events].sort((a, b) => a.timestamp_ms - b.timestamp_ms);
  return ordered
    .map((event) => {
      const cls = EVENT_CLASS[event.type] ?? "ev-session";
      const label = EVENT_LABEL[event.type] ?? event.type;
      const who = event.threat_id ?? "—";
      const detail = decisionDetail(event);
      return `<tr class="aar-ev ${cls}">`
        + `<td class="aar-num">${(event.timestamp_ms / 1000).toFixed(1)}s</td>`
        + `<td>${who}</td>`
        + `<td>${label}</td>`
        + `<td class="aar-decision">${detail}</td></tr>`;
    })
    .join("");
}

export function timelineBlock(aar: AAR): string {
  return `<section class="aar-card aar-card-wide">
    <h3>Timeline</h3>
    <table class="aar-table">
      <tr><th>time</th><th>contact</th><th>event</th><th>decision</th></tr>
      ${timelineRows(aar.timeline)}
    </table>
  </section>`;
}

// Post-session reveal: every contact's answers, so the trainee can study
// what each observed signature actually meant. Served by the server only
// inside the completed-session AAR -- never during play.
export function groundTruthBlock(aar: AAR): string {
  if (aar.ground_truth.length === 0) return "";
  const rows = aar.ground_truth
    .map((entry) =>
      `<tr><td>${entry.threat_id}</td><td>${entry.classification_label}</td>`
      + `<td>${entry.expected_response}</td></tr>`)
    .join("");
  return `<section class="aar-card aar-card-wide">
    <h3>Ground truth — revealed after the session</h3>
    <table class="aar-table">
      <tr><th>contact</th><th>classification</th><th>expected response</th></tr>
      ${rows}
    </table>
  </section>`;
}

// ---------------------------------------------------------------------------
// Per-contact story
// ---------------------------------------------------------------------------

export interface ContactCard {
  id: string;
  truthLabel: string;
  truthResponse: string;
  spawnedMs: number | null;
  detectedMs: number | null;
  detectSensor: string | null;
  firstSeenMs: number | null;
  classifiedAs: string | null;
  classificationOk: boolean | null;
  respondedAs: string | null;
  responseOk: boolean | null;
  mistakeKinds: string[];
}

function payloadString(payload: Record<string, unknown> | undefined, key: string): string | null {
  const value = payload?.[key];
  return typeof value === "string" ? value : null;
}

function payloadMs(payload: Record<string, unknown> | undefined, key: string): number | null {
  const value = payload?.[key];
  return typeof value === "number" ? value : null;
}

/**
 * One narrative card per contact: what it was, when it entered the sensor
 * picture, what the trainee did at each step, and what went wrong.
 * Assembled from timeline first-events plus the post-session reveal --
 * no new data, just the story the tables only imply.
 */
export function contactCards(aar: AAR): ContactCard[] {
  const firstBy = (type: string, id: string) =>
    aar.timeline.find((event) => event.type === type && event.threat_id === id);
  return aar.ground_truth.map((truth) => {
    const spawned = firstBy("THREAT_SPAWNED", truth.threat_id);
    const detected = firstBy("THREAT_DETECTED", truth.threat_id);
    const classified = firstBy("CLASSIFICATION_SUBMITTED", truth.threat_id);
    const responded = firstBy("RESPONSE_SUBMITTED", truth.threat_id);
    const label = payloadString(classified?.payload, "label");
    const response = payloadString(responded?.payload, "response");
    const sensor = payloadString(detected?.payload, "sensor");
    const observer = payloadString(detected?.payload, "observer");
    return {
      id: truth.threat_id,
      truthLabel: truth.classification_label,
      truthResponse: truth.expected_response,
      spawnedMs: spawned?.timestamp_ms ?? null,
      detectedMs: detected?.timestamp_ms ?? null,
      detectSensor: observer && sensor ? `${observer} · ${sensor}` : sensor,
      firstSeenMs: payloadMs(detected?.payload, "first_seen_ms"),
      classifiedAs: label,
      classificationOk: label === null ? null : label === truth.classification_label,
      respondedAs: response,
      responseOk: response === null ? null : response === truth.expected_response,
      mistakeKinds: aar.mistakes
        .filter((m) => m.threat_id === truth.threat_id)
        .map((m) => m.kind),
    };
  });
}

function seconds(ms: number | null): string {
  return ms === null ? "—" : `${(ms / 1000).toFixed(1)}s`;
}

function verdict(ok: boolean | null, Fallback = "—"): string {
  if (ok === null) return `<span class="cc-dim">${Fallback}</span>`;
  return ok ? `<span class="cc-ok">✓</span>` : `<span class="cc-bad">✗</span>`;
}

export function contactCardsBlock(aar: AAR): string {
  const cards = contactCards(aar);
  if (cards.length === 0) return "";
  const html = cards
    .map((card) => {
      const mistakes = card.mistakeKinds.length > 0
        ? `<div class="cc-row"><span>Issues</span><span>${card.mistakeKinds.join(", ")}</span></div>`
        : "";
      const spotted = card.detectedMs === null
        ? `<div class="cc-row"><span>Spotted</span><span class="cc-bad">never detected</span></div>`
        : `<div class="cc-row"><span>Spotted</span><span>${seconds(card.detectedMs)}`
        + `${card.detectSensor ? ` via ${card.detectSensor}` : ""}`
        + `${card.firstSeenMs !== null ? ` (first seen ${seconds(card.firstSeenMs)})` : ""}</span></div>`;
      return `<div class="aar-card contact-card">
        <h4>${card.id} <span class="cc-dim">· ${card.truthLabel} · ${card.truthResponse}</span></h4>
        ${spotted}
        <div class="cc-row"><span>Classified</span><span>${card.classifiedAs ?? "—"} ${verdict(card.classificationOk)}</span></div>
        <div class="cc-row"><span>Responded</span><span>${card.respondedAs ?? "—"} ${verdict(card.responseOk)}</span></div>
        ${mistakes}
      </div>`;
    })
    .join("");
  return `<section class="aar-card-wide">
    <h3>Contacts</h3>
    <div class="contact-grid">${html}</div>
  </section>`;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

const MISTAKE_LABEL: Record<string, string> = {
  missed_threat: "Missed contact",
  false_alarm: "False alarm",
  classification_error: "Wrong classification",
  response_error: "Wrong response",
};

const MISTAKE_CLASS: Record<string, string> = {
  missed_threat: "is-bad",
  false_alarm: "is-warn",
  classification_error: "is-warn",
  response_error: "is-warn",
};

export function mistakeCounts(mistakes: AAR["mistakes"]): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const m of mistakes) counts.set(m.kind, (counts.get(m.kind) ?? 0) + 1);
  return [...counts.entries()];
}

export function mistakeSummary(mistakes: AAR["mistakes"]): string {
  if (mistakes.length === 0) return "";
  return mistakeCounts(mistakes)
    .map(([kind, n]) => `${n} ${(MISTAKE_LABEL[kind] ?? kind).toLowerCase()}${n === 1 ? "" : "s"}`)
    .join(" · ");
}

export function mistakeRows(aar: AAR): string {
  if (aar.mistakes.length === 0) {
    return `<tr><td colspan="3" class="aar-empty">No errors recorded.</td></tr>`;
  }
  return aar.mistakes
    .map((m) => {
      const label = MISTAKE_LABEL[m.kind] ?? m.kind;
      const at = (m.timestamp_ms / 1000).toFixed(1);
      const who = m.threat_id ?? "—";
      return `<tr><td>${at}s</td><td>${who}</td>`
        + `<td><span class="aar-chip ${MISTAKE_CLASS[m.kind] ?? ""}">${label}</span>`
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

// Nullable server fields must render as an em dash, never "NaN" or "null".
export function formatMetric(value: number | null, suffix = ""): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${Math.round(value)}${suffix}`;
}

export function formatSeconds(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "—";
  return `${(ms / 1000).toFixed(1)}s`;
}

// Cumulative record across every session, not just this one. These fields were
// all fetched and previously discarded, so the adaptive engine's work was
// invisible.
export function performanceStats(profile: PerformanceProfile): string {
  const tiles: Array<[string, string]> = [
    ["Sessions", String(profile.session_count)],
    ["Adaptive level", String(profile.current_level)],
    ["Detection", formatMetric(profile.detection_accuracy, "%")],
    ["Classification", formatMetric(profile.classification_accuracy, "%")],
    ["Response", formatMetric(profile.response_accuracy, "%")],
    ["Avg reaction", formatSeconds(profile.average_reaction_time_ms)],
  ];
  return `<div class="aar-stats">${
    tiles.map(([label, value]) =>
      `<div class="aar-stat"><span>${label}</span><b>${value}</b></div>`).join("")
  }</div>`;
}

export function performanceBlock(profile: PerformanceProfile | null): string {
  if (!profile) return "";
  // Grouped the way the backend computes them, so a gap is easier to spot.
  const groups: Array<[string, Array<[string, number | null]>]> = [
    ["Environment", [["Urban", profile.urban_score], ["Rural", profile.rural_score]]],
    ["Time", [["Day", profile.day_score], ["Night", profile.night_score]]],
    ["Visibility", [
      ["Clear", profile.clear_visibility_score],
      ["Reduced", profile.reduced_visibility_score],
      ["Poor", profile.poor_visibility_score],
      ["Low vis", profile.low_visibility_score],
    ]],
    ["Sensor", [
      ["High", profile.high_sensor_score],
      ["Medium", profile.medium_sensor_score],
      ["Low", profile.low_sensor_score],
    ]],
    ["Contacts", [["Multi-threat", profile.multi_threat_score]]],
  ];
  const cells = groups
    .map(([group, items]) => {
      const inner = items
        .map(([label, value]) =>
          `<div class="aar-cond"><span>${label}</span><b>${formatMetric(value)}</b></div>`)
        .join("");
      return `<div class="aar-condgroup"><span class="aar-condgroup-label">${group}</span>${inner}</div>`;
    })
    .join("");
  return `${performanceStats(profile)}<div class="aar-conds">${cells}</div>`;
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

export function errorBanner(errors: string[]): string {
  if (errors.length === 0) return "";
  return `<div class="aar-error" role="alert">
    <strong>Some review data could not be loaded.</strong>
    <ul>${errors.map((e) => `<li>${e}</li>`).join("")}</ul>
  </div>`;
}

export function buildAarHtml(
  aar: AAR,
  recommendation: RecommendResponse | null,
  profile: PerformanceProfile | null,
  loading: boolean,
  header: SessionHeader | null = null,
  errors: string[] = [],
): string {
  const mistakeSummaryText = mistakeSummary(aar.mistakes);
  return `
    <h2>After Action Review</h2>
    ${scoreHero(aar, header)}
    ${errorBanner(errors)}
    ${loading ? `<p class="aar-loading">Loading full review from server…</p>` : ""}
    <div class="aar-grid">
      <section class="aar-card">
        <h3>Score breakdown</h3>
        <table class="aar-table">${scoreRows(aar)}</table>
        <p class="aar-meta">scenario ${aar.scenario_id} · scoring v${aar.scores.scoring_version}</p>
      </section>

      <section class="aar-card">
        <h3>Assessment</h3>
        <p class="aar-summary">${aar.summary}</p>
        ${assessmentBlock(aar)}
        <p class="aar-rec"><b>Instructor focus:</b> ${aar.recommendation}</p>
      </section>

      <section class="aar-card">
        <h3>Timing</h3>
        <table class="aar-table">${timingRows(aar)}</table>
        <p class="aar-meta">Targets: ≤3.0s full marks, ≤6.0s partial.</p>
      </section>

      <section class="aar-card">
        <h3>Errors</h3>
        ${mistakeSummaryText ? `<p class="aar-errorcount">${mistakeSummaryText}</p>` : ""}
        <table class="aar-table">
          <tr><th>time</th><th>contact</th><th>issue</th></tr>
          ${mistakeRows(aar)}
        </table>
      </section>
    </div>
    ${contactCardsBlock(aar)}
    ${timelineBlock(aar)}
    ${groundTruthBlock(aar)}
    ${performanceBlock(profile)}
    ${recommendationBlock(recommendation)}
    <div class="aar-actions">
      <button id="again">Play again</button>
      <button id="aar-performance" class="aar-secondary">View performance</button>
    </div>`;
}