import type {
  ClassificationLabel, EventCreateRequest, ExpectedResponse, PublicThreat,
} from "../api/types";
import { events } from "./events";

export type ThreatStage = "pending" | "spawned" | "detected" | "classified" | "responded";
export type SessionStatus = "idle" | "active" | "completing" | "complete";
export type OperatorRole = "station" | "airborne";

/**
 * Initial gameplay selection by operator role. The ground station must start
 * unlocked: pre-selecting the first contact hands the trainee the search that
 * recognition training is meant to measure. Airborne keeps the historical
 * first-contact selection.
 */
export function initialSelectedThreatId(
  role: OperatorRole,
  threatIds: readonly string[],
): string | null {
  if (role !== "airborne") return null;
  return threatIds[0] ?? null;
}

export interface ThreatState {
  // Public threat only: the session state machine tracks workflow stages
  // against observable contacts, never ground-truth labels.
  profile: PublicThreat;
  stage: ThreatStage;
}

export interface SessionControllerOptions {
  emit: (event: EventCreateRequest) => void;
  now: () => number;
}

export class SessionController {
  readonly scenario: { threats: PublicThreat[] };
  readonly sessionId: string;
  readonly traineeId: string;
  readonly events: EventCreateRequest[] = [];
  readonly threats: ThreatState[];
  status: SessionStatus = "active";

  private readonly emit: (event: EventCreateRequest) => void;
  private readonly now: () => number;

  constructor(
    scenario: { threats: PublicThreat[] },
    sessionId: string,
    traineeId: string,
    options: SessionControllerOptions,
  ) {
    this.scenario = scenario;
    this.sessionId = sessionId;
    this.traineeId = traineeId;
    this.emit = options.emit;
    this.now = options.now;
    this.threats = scenario.threats.map((profile) => ({ profile, stage: "pending" }));
  }

  private threat(id: string): ThreatState | undefined {
    return this.threats.find((t) => t.profile.id === id);
  }

  private record(event: EventCreateRequest): void {
    this.events.push(event);
    this.emit(event);
  }

  start(): void {
    this.record(events.sessionStarted(this.now()));
    this.record(events.scenarioLoaded(this.now()));
  }

  spawnThreat(id: string): void {
    const threat = this.threat(id);
    if (threat === undefined || threat.stage !== "pending") return;
    threat.stage = "spawned";
    this.record(events.threatSpawned(id, this.now()));
  }

  detect(id: string, provenance: Record<string, unknown> = {}): boolean {
    const threat = this.threat(id);
    if (threat === undefined || threat.stage !== "spawned") return false;
    threat.stage = "detected";
    // Provenance (which observer, which sensor) is recorded for the AAR
    // timeline. Scoring ignores payloads, so this cannot change the score.
    this.record(events.threatDetected(id, this.now(), provenance));
    return true;
  }

  classify(
    id: string,
    label: ClassificationLabel,
    provenance: Record<string, unknown> = {},
  ): boolean {
    const threat = this.threat(id);
    if (threat === undefined || threat.stage !== "detected") return false;
    threat.stage = "classified";
    this.record(events.classification(id, label, this.now(), provenance));
    return true;
  }

  respond(
    id: string,
    response: ExpectedResponse,
    provenance: Record<string, unknown> = {},
  ): boolean {
    const threat = this.threat(id);
    if (threat === undefined || threat.stage !== "classified") return false;
    threat.stage = "responded";
    this.record(events.response(id, response, this.now(), provenance));
    this.record(events.threatResolved(id, this.now()));
    return true;
  }

  falseAlarm(): void {
    this.record(events.falseAlarm(this.now()));
  }

  complete(): void {
    if (this.status !== "active") return;
    this.status = "completing";
    this.record(events.sessionCompleted(this.now()));
  }
}
