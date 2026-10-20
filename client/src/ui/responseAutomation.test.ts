import { describe, expect, it } from "vitest";
import type { EventCreateRequest } from "../api/types";
import { RESPONSE_WORKFLOW_KEY } from "../sim/response";
import { isResponseWorkflowEvent, responseNotice } from "./responseAutomation";

function workflowEvent(payload: Record<string, unknown>): EventCreateRequest {
  return {
    type: "RESPONSE_SUBMITTED",
    timestamp_ms: 5000,
    threat_id: null,
    payload: { workflow: RESPONSE_WORKFLOW_KEY, threat: "T01", ...payload },
  };
}

describe("isResponseWorkflowEvent", () => {
  it("identifies workflow records and ignores scored events", () => {
    expect(isResponseWorkflowEvent(workflowEvent({ phase: "proposal" }))).toBe(true);
    expect(isResponseWorkflowEvent({
      type: "RESPONSE_SUBMITTED", timestamp_ms: 5000, threat_id: "T01",
      payload: { response: "hold" },
    })).toBe(false);
  });
});

describe("responseNotice", () => {
  it("announces a resolved simulation with a gain tone", () => {
    const notice = responseNotice(workflowEvent({ phase: "completed", outcome: "neutralized" }));
    expect(notice).toEqual({
      id: "T01", tone: "gain", text: "T01 simulated response resolved — neutralized",
    });
  });

  it("announces an unresolved simulation with a loss tone", () => {
    const notice = responseNotice(workflowEvent({ phase: "completed", outcome: "failed" }));
    expect(notice).toEqual({
      id: "T01", tone: "loss", text: "T01 simulated response failed — not neutralized",
    });
  });

  it("announces an automated proposal with an info tone", () => {
    const notice = responseNotice(workflowEvent({ phase: "proposal", auto: true }));
    expect(notice).toEqual({
      id: "T01", tone: "info", text: "T01 automated proposal ready — review the simulated response",
    });
  });

  it("keeps a manual proposal silent, auto flag or not", () => {
    expect(responseNotice(workflowEvent({ phase: "proposal" }))).toBeNull();
    expect(responseNotice(workflowEvent({ phase: "proposal", auto: false }))).toBeNull();
  });

  it("stays silent for the phases the trainee caused with their own clicks", () => {
    for (const phase of ["approved", "rejected", "cancelled", "invalid"]) {
      expect(responseNotice(workflowEvent({ phase }))).toBeNull();
    }
  });

  it("stays silent for non-workflow and malformed events", () => {
    expect(responseNotice({
      type: "FALSE_ALARM", timestamp_ms: 900, threat_id: null, payload: {},
    })).toBeNull();
    expect(responseNotice(workflowEvent({ phase: "completed" }))).toBeNull(); // no outcome
    expect(responseNotice(workflowEvent({ phase: "completed", outcome: "maybe" }))).toBeNull();
  });

  it("is stateless and deterministic: one event, one notice, replay-safe", () => {
    const event = workflowEvent({ phase: "completed", outcome: "failed" });
    const first = responseNotice(event);
    responseNotice(workflowEvent({ phase: "proposal" }));
    expect(responseNotice(event)).toEqual(first); // nothing leaked between calls
  });

  it("uses simulation-only wording and never exposes hidden answers", () => {
    const source = JSON.stringify([
      responseNotice(workflowEvent({ phase: "completed", outcome: "neutralized" })),
      responseNotice(workflowEvent({ phase: "completed", outcome: "failed" })),
      responseNotice(workflowEvent({ phase: "proposal", auto: true })),
    ]).toLowerCase();
    expect(source).toContain("simulated");
    for (const leaked of [
      "hostile", "friendly", "unidentified", "classification_label",
      "expected_response", "weapon", "engage", "intercept", "target",
    ]) {
      expect(source).not.toContain(leaked);
    }
  });
});
