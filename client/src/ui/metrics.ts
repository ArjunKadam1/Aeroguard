// Manual vs Assisted decision metrics for the After Action Review.
//
// Derived client-side from the recorded timeline. Response payloads carry aid
// provenance stamped at decision time -- "assisted" when the simulated-response
// assistant was in play for that contact, "manual" otherwise -- which drives
// the response-handling split. Decision payloads additionally name their actor
// (`by: "assistant"` or `"operator"`), which drives the per-stage assistant
// counts. Both therefore come from the decision records themselves, not from
// re-deriving workflow history, and they survive a server round-trip unchanged.
//
// Server persistence is deliberately deferred: the AAR already ships the
// timeline, so the split needs no schema or endpoint change, and sessions
// recorded before the stamp existed report as unrecorded rather than being
// silently assumed manual.
//
// Pure and node-testable: no DOM, no state, no probabilities.

import type { EventCreateRequest } from "../api/types";
import { RESPONSE_WORKFLOW_KEY } from "../sim/response";

export interface ResponseModeSplit {
  /** Scored responses with no recorded assistant involvement. */
  manual: number;
  /** Scored responses whose contact used the simulated-response assistant. */
  assisted: number;
  /** Scored responses recorded before aid provenance existed. */
  unrecorded: number;
}

/**
 * Counts scored responses by how they were handled. Workflow phase records
 * ride the same carrier type with a null threat_id and an explicit workflow
 * key, so they are excluded first; every other response event is classified by
 * its aid provenance.
 */
export function responseModeSplit(timeline: readonly EventCreateRequest[]): ResponseModeSplit {
  const split: ResponseModeSplit = { manual: 0, assisted: 0, unrecorded: 0 };
  for (const event of timeline) {
    if (event.type !== "RESPONSE_SUBMITTED" || event.threat_id === null) continue;
    if (event.payload?.workflow === RESPONSE_WORKFLOW_KEY) continue;
    const aid = event.payload?.aid;
    if (aid === "assisted") split.assisted += 1;
    else if (aid === "manual") split.manual += 1;
    else split.unrecorded += 1;
  }
  return split;
}

export interface ResponseClassCounts {
  /** Contacts whose first simulation request of the session was a mitigation. */
  mitigation: number;
  /** Contacts whose first simulation request of the session was weapon-class. */
  weaponClass: number;
}

/**
 * How many contacts requested each abstract simulation class, counted once per
 * contact from the workflow proposal records: a rejected-and-reopened contact
 * that requests again still counts by its first request. A proposal recorded
 * before classes existed reads as a mitigation, because that is what it was.
 */
export function responseClassCounts(timeline: readonly EventCreateRequest[]): ResponseClassCounts {
  const counts: ResponseClassCounts = { mitigation: 0, weaponClass: 0 };
  const seen = new Set<string>();
  for (const event of timeline) {
    if (event.payload?.workflow !== RESPONSE_WORKFLOW_KEY) continue;
    if (event.payload?.phase !== "proposal") continue;
    const threat = event.payload.threat;
    if (typeof threat !== "string" || seen.has(threat)) continue;
    seen.add(threat);
    if (event.payload.response_class === "weapon-class") counts.weaponClass += 1;
    else counts.mitigation += 1;
  }
  return counts;
}

export interface StageDecisionSplit {
  /** Decision events recorded for this stage (workflow carriers excluded). */
  total: number;
  /** Of those, decisions taken by the AI assistant. */
  assisted: number;
}

export interface DecisionAssistSplit {
  detect: StageDecisionSplit;
  classify: StageDecisionSplit;
  respond: StageDecisionSplit;
}

/**
 * Per-stage assistant decision counts, from the provenance the session
 * controller stamps in assisted mode. Detection, classification and response
 * events recorded by the assistant carry `by: "assistant"`; an operator
 * override inside an assisted session carries `by: "operator"` and is not
 * counted as an assistant decision. Manual sessions record no `by` at all, so
 * they read as zero assistant decisions rather than being assumed either way.
 */
export function decisionAssistSplit(
  timeline: readonly EventCreateRequest[],
): DecisionAssistSplit {
  const split: DecisionAssistSplit = {
    detect: { total: 0, assisted: 0 },
    classify: { total: 0, assisted: 0 },
    respond: { total: 0, assisted: 0 },
  };
  for (const event of timeline) {
    if (event.threat_id === null || event.threat_id === undefined) continue;
    const assisted = event.payload?.by === "assistant";
    if (event.type === "THREAT_DETECTED") {
      split.detect.total += 1;
      if (assisted) split.detect.assisted += 1;
    } else if (event.type === "CLASSIFICATION_SUBMITTED") {
      split.classify.total += 1;
      if (assisted) split.classify.assisted += 1;
    } else if (event.type === "RESPONSE_SUBMITTED"
      && event.payload?.workflow !== RESPONSE_WORKFLOW_KEY) {
      split.respond.total += 1;
      if (assisted) split.respond.assisted += 1;
    }
  }
  return split;
}
