// Contextual assessment guidance: what the selected contact's observable
// evidence supports, and what would firm it up before committing a
// classification.
//
// Information boundary: guidance is built ONLY from trainee-visible evidence --
// the public behavior signature and its readability, the track lifecycle, the
// holding sensor, and the session stage. It never maps a signature to a
// classification label: the server's signature projection is a hidden-truth
// cue, so a client-side signature-to-label lookup would be a truth oracle for
// every cleanly-read contact and would hand the trainee the answer the
// classification score measures. The doctrine meaning itself stays where the
// server publishes it, verbatim, in the panel's Doctrine row; guidance only
// frames how to weigh it.
//
// Advisory only: the caller renders this as text. It never preselects a
// classification, never submits anything, and never changes a gate -- the
// session stage machine and sensor permissions stay the only authority on
// what may be done next. Pure and deterministic.

import type { TrackState } from "./observation";

/** Session stage values this module reasons about; mirrors state/session. */
export type AssessmentStage = "pending" | "spawned" | "detected" | "classified" | "responded";

export interface AssessmentEvidence {
  stage: AssessmentStage;
  /** Track lifecycle state, or "unseen" while no sensor holds the contact. */
  track: TrackState | "unseen";
  /** Sensor currently holding the track; ignored while unseen. */
  sensor: "visual" | "radar";
  /** Observable signature, e.g. "direct-approach" or "indeterminate". */
  behavior: string;
  /** Whether the signature read cleanly under current conditions. */
  cueClear: boolean;
}

const CLEAN =
  "The signature reads cleanly; treat the doctrine meaning as a prior, not a verdict.";

const DEGRADED =
  "The signature is unreadable under current conditions — the cue is degraded, not absent.";

/**
 * What the track currently supports. Classification permission is a sensor
 * fact (a visual fix must have been held at least once), so the line tells the
 * trainee exactly what stands between them and a committed assessment.
 */
function evidenceLine(evidence: AssessmentEvidence): string {
  const { track, sensor } = evidence;
  if (track === "unseen") {
    return "No sensor holds this contact right now; classification needs a visual fix.";
  }
  if (track === "coasting") {
    return sensor === "visual"
      ? "The visual track is coasting — still evidence, but refresh the hold soon."
      : "The radar track is coasting; classification still needs a visual fix.";
  }
  if (track === "tentative") {
    return sensor === "visual"
      ? "The visual track is tentative — commit the classification your observation supports, or hold a moment longer."
      : "The radar track is tentative; classification still needs a visual fix.";
  }
  return sensor === "visual"
    ? "A confirmed visual fix holds — commit the classification your observation supports."
    : "Radar confirms position only; classification needs a visual fix: aim a visual sensor at the contact or wait for a visual pass.";
}

/**
 * One advisory line for the classification decision that is currently pending,
 * or null when no classification decision is open (before detection, after a
 * classification, or after the response).
 */
export function assessmentGuidance(evidence: AssessmentEvidence): string | null {
  if (evidence.stage !== "detected") return null;
  const cue = evidence.cueClear && evidence.behavior !== "indeterminate" ? CLEAN : DEGRADED;
  return `${cue} ${evidenceLine(evidence)}`;
}
