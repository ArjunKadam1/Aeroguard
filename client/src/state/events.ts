import type {
  ClassificationLabel, EventCreateRequest, EventType, ExpectedResponse,
} from "../api/types";

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
  falseAlarm: (ts: number) => buildEvent("FALSE_ALARM", ts),
  sessionCompleted: (ts: number) => buildEvent("SESSION_COMPLETED", ts),
};
