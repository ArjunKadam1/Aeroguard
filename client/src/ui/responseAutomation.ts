// Event-driven notifications for the simulated-response workflow.
//
// Transitions the trainee does not trigger with their own click get the alert
// strip: the asynchronous resolution of an approved simulation, and a proposal
// the idle automation requested on their behalf (the inline panel may not be
// open on that contact). Request, approval, rejection and cancellation are
// direct answers to a click and are already shown inline in the Response
// assistant, and repeating them in the attention channel would dilute it.
//
// Pure and node-testable by construction: notices derive from the submitted
// event itself, so each event yields at most one notice (dedupe by event), a
// fresh session starts from an empty strip (reset-safety falls out of the
// stateless function), and no per-frame work exists anywhere. Wording is
// simulation-only and never names a hidden label, an expected response, or a
// real-world action.

import type { EventCreateRequest } from "../api/types";
import { RESPONSE_WORKFLOW_KEY } from "../sim/response";
import type { AlertLike } from "./alerts";

/** True for phase records of the simulated-response workflow. */
export function isResponseWorkflowEvent(event: EventCreateRequest): boolean {
  return event.payload?.workflow === RESPONSE_WORKFLOW_KEY;
}

/**
 * The alert-strip notice for a submitted workflow event, or null when the
 * event warrants none. Resolved simulations always notify; a proposal the idle
 * automation requested also notifies, because no click of the trainee's caused
 * it and the inline panel may not be open on that contact. Everything else is
 * a direct answer to a click and stays inline. Phase and outcome come from the
 * immutable payload, so replaying the same event can never produce a different
 * notice and no state can leak between sessions.
 */
export function responseNotice(event: EventCreateRequest): AlertLike | null {
  if (!isResponseWorkflowEvent(event)) return null;
  const payload = event.payload ?? {};
  const id = typeof payload.threat === "string" ? payload.threat : "contact";
  if (payload.phase === "proposal" && payload.auto === true) {
    return { id, tone: "info", text: `${id} automated proposal ready — review the simulated response` };
  }
  if (payload.phase !== "completed") return null;
  if (payload.outcome === "neutralized") {
    return { id, tone: "gain", text: `${id} simulated response resolved — neutralized` };
  }
  if (payload.outcome === "failed") {
    return { id, tone: "loss", text: `${id} simulated response failed — not neutralized` };
  }
  return null;
}
