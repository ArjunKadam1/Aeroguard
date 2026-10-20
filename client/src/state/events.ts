import type {
  ClassificationLabel, EventCreateRequest, EventType, ExpectedResponse,
} from "../api/types";
import type { ResponseWorkflowEventPayload } from "../sim/response";

export interface EventOptions {
  threat_id?: string | null;
  payload?: Record<string, unknown>;
}

export function buildEvent(
  type: EventType,
  timestamp_ms: number,
  opts: EventOptions = {},
): EventCreateRequest {
  return {
    type,
    timestamp_ms,
    threat_id: opts.threat_id ?? null,
    payload: opts.payload ?? {},
  };
}

export const events = {
  sessionStarted: (ts: number) => buildEvent("SESSION_STARTED", ts),
  scenarioLoaded: (ts: number) => buildEvent("SCENARIO_LOADED", ts),
  threatSpawned: (id: string, ts: number) =>
    buildEvent("THREAT_SPAWNED", ts, { threat_id: id }),
  threatDetected: (id: string, ts: number, payload: Record<string, unknown> = {}) =>
    buildEvent("THREAT_DETECTED", ts, { threat_id: id, payload }),
  classification: (
    id: string,
    label: ClassificationLabel,
    ts: number,
    provenance: Record<string, unknown> = {},
  ) => buildEvent("CLASSIFICATION_SUBMITTED", ts, {
    threat_id: id, payload: { label, ...provenance },
  }),
  response: (
    id: string,
    response: ExpectedResponse,
    ts: number,
    provenance: Record<string, unknown> = {},
  ) => buildEvent("RESPONSE_SUBMITTED", ts, {
    threat_id: id, payload: { response, ...provenance },
  }),
  threatResolved: (id: string, ts: number) =>
    buildEvent("THREAT_RESOLVED", ts, { threat_id: id }),
  /**
   * Simulated-response workflow record. Deliberately submitted with a null
   * threat_id: the server accepts it without threat validation, scoring and
   * per-threat AAR logic match events on threat_id so they never see it, and
   * the payload carries the phase. The carrier type keeps the frozen v1 event
   * contract; ui/responseAutomation labels these rows for the trainee.
   */
  responseWorkflow: (ts: number, payload: ResponseWorkflowEventPayload) =>
    buildEvent("RESPONSE_SUBMITTED", ts, { payload: { ...payload } }),
  falseAlarm: (ts: number) => buildEvent("FALSE_ALARM", ts),
  sessionCompleted: (ts: number) => buildEvent("SESSION_COMPLETED", ts),
};
