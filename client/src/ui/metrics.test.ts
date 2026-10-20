import { describe, expect, it } from "vitest";
import type { EventCreateRequest } from "../api/types";
import { decisionAssistSplit, responseClassCounts, responseModeSplit } from "./metrics";

function response(
  threatId: string | null,
  payload: Record<string, unknown> | undefined,
): EventCreateRequest {
  return { type: "RESPONSE_SUBMITTED", timestamp_ms: 1000, threat_id: threatId, payload };
}

describe("responseModeSplit", () => {
  it("counts manual and assisted decisions from aid provenance", () => {
    const split = responseModeSplit([
      response("T01", { response: "hold", aid: "manual" }),
      response("T02", { response: "monitor", aid: "assisted" }),
      response("T03", { response: "hold", aid: "assisted" }),
    ]);
    expect(split).toEqual({ manual: 1, assisted: 2, unrecorded: 0 });
  });

  it("ignores workflow phase records and non-response events", () => {
    const split = responseModeSplit([
      {
        type: "RESPONSE_SUBMITTED", timestamp_ms: 900, threat_id: null,
        payload: { workflow: "response-simulation", phase: "completed", threat: "T01", outcome: "neutralized" },
      },
      { type: "THREAT_DETECTED", timestamp_ms: 1000, threat_id: "T01" },
      { type: "FALSE_ALARM", timestamp_ms: 1100, threat_id: null },
      response("T01", { response: "hold", aid: "manual" }),
    ]);
    expect(split).toEqual({ manual: 1, assisted: 0, unrecorded: 0 });
  });

  it("reports responses without provenance as unrecorded, never assumed manual", () => {
    const split = responseModeSplit([response("T01", { response: "hold" })]);
    expect(split).toEqual({ manual: 0, assisted: 0, unrecorded: 1 });
  });

  it("returns zeroes for an empty timeline", () => {
    expect(responseModeSplit([])).toEqual({ manual: 0, assisted: 0, unrecorded: 0 });
  });
});

describe("responseClassCounts", () => {
  function proposal(threat: string, responseClass?: string): EventCreateRequest {
    return {
      type: "RESPONSE_SUBMITTED", timestamp_ms: 900, threat_id: null,
      payload: {
        workflow: "response-simulation",
        phase: "proposal",
        threat,
        ...(responseClass === undefined ? {} : { response_class: responseClass }),
      },
    };
  }

  it("counts each contact's first requested class once", () => {
    const counts = responseClassCounts([
      proposal("T01", "mitigation"),
      proposal("T02", "weapon-class"),
      proposal("T01", "weapon-class"), // reopened and re-requested: still one contact
      { type: "THREAT_DETECTED", timestamp_ms: 1000, threat_id: "T01" },
    ]);
    expect(counts).toEqual({ mitigation: 1, weaponClass: 1 });
  });

  it("reads a proposal recorded before classes existed as a mitigation", () => {
    expect(responseClassCounts([proposal("T01")])).toEqual({ mitigation: 1, weaponClass: 0 });
  });

  it("ignores non-proposal phases and returns zeroes for an empty timeline", () => {
    const counts = responseClassCounts([
      {
        type: "RESPONSE_SUBMITTED", timestamp_ms: 900, threat_id: null,
        payload: { workflow: "response-simulation", phase: "completed", threat: "T01" },
      },
      { type: "FALSE_ALARM", timestamp_ms: 1000, threat_id: null },
    ]);
    expect(counts).toEqual({ mitigation: 0, weaponClass: 0 });
    expect(responseClassCounts([])).toEqual({ mitigation: 0, weaponClass: 0 });
  });
});

describe("decisionAssistSplit", () => {
  function event(
    type: EventCreateRequest["type"],
    threatId: string | null,
    payload?: Record<string, unknown>,
  ): EventCreateRequest {
    return { type, timestamp_ms: 1000, threat_id: threatId, payload };
  }

  it("counts assistant decisions per stage from decision provenance", () => {
    const split = decisionAssistSplit([
      event("THREAT_DETECTED", "T01", { aid: "assisted", by: "assistant" }),
      event("CLASSIFICATION_SUBMITTED", "T01", {
        label: "hostile", aid: "assisted", by: "assistant",
      }),
      response("T01", { response: "hold", aid: "assisted", by: "assistant" }),
      event("THREAT_DETECTED", "T02"),
      event("CLASSIFICATION_SUBMITTED", "T02", { label: "friendly" }),
      response("T02", { response: "monitor", aid: "manual" }),
    ]);
    expect(split).toEqual({
      detect: { total: 2, assisted: 1 },
      classify: { total: 2, assisted: 1 },
      respond: { total: 2, assisted: 1 },
    });
  });

  it("does not count an operator override inside an assisted session", () => {
    const split = decisionAssistSplit([
      event("THREAT_DETECTED", "T01", { aid: "assisted", by: "operator" }),
      event("CLASSIFICATION_SUBMITTED", "T01", {
        label: "hostile", aid: "assisted", by: "operator",
      }),
      response("T01", { response: "hold", aid: "assisted", by: "operator" }),
    ]);
    expect(split).toEqual({
      detect: { total: 1, assisted: 0 },
      classify: { total: 1, assisted: 0 },
      respond: { total: 1, assisted: 0 },
    });
  });

  it("reads unsigned manual decisions as zero assisted, never assumed either way", () => {
    const split = decisionAssistSplit([
      event("THREAT_DETECTED", "T01", { observer: "station", sensor: "visual" }),
      event("CLASSIFICATION_SUBMITTED", "T01", { label: "unknown" }),
      response("T01", { response: "track" }),
    ]);
    expect(split).toEqual({
      detect: { total: 1, assisted: 0 },
      classify: { total: 1, assisted: 0 },
      respond: { total: 1, assisted: 0 },
    });
  });

  it("ignores workflow carriers, false alarms, and contactless records", () => {
    const split = decisionAssistSplit([
      {
        type: "RESPONSE_SUBMITTED", timestamp_ms: 900, threat_id: null,
        payload: { workflow: "response-simulation", phase: "proposal", threat: "T01" },
      },
      event("FALSE_ALARM", null),
      event("THREAT_SPAWNED", "T01", { aid: "assisted" }),
    ]);
    expect(split).toEqual({
      detect: { total: 0, assisted: 0 },
      classify: { total: 0, assisted: 0 },
      respond: { total: 0, assisted: 0 },
    });
  });

  it("returns zeroes for an empty timeline", () => {
    expect(decisionAssistSplit([])).toEqual({
      detect: { total: 0, assisted: 0 },
      classify: { total: 0, assisted: 0 },
      respond: { total: 0, assisted: 0 },
    });
  });
});
