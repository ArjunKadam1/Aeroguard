import type {
  ClassificationLabel, EventCreateRequest, ExpectedResponse, PublicThreat,
} from "../api/types";
import {
  AUTO_REQUEST_MS, RESPONSE_PROCESSING_MS, ResponseBook, applyAction, buildProposal,
  workflowEventPayload,
  type ResponseClass, type ResponseConfig, type ResponseOutcome, type ResponseWorkflow,
  type ResponseWorkflowPhase,
} from "../sim/response";
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

/** Simulated-response model wiring: public conditions and the outcome resolver. */
export interface ResponseSimulationOptions {
  /** Scenario-level availability, derived from public conditions. */
  config: ResponseConfig;
  /** Deterministic per-contact outcome, or null when resolution is unavailable. */
  resolve: (threatId: string) => ResponseOutcome | null;
  /**
   * Whether a sensor track currently holds the contact, for the idle
   * auto-request automation. The manual request path takes `tracked`
   * explicitly, so this is only read when the automation fires.
   */
  tracked?: (threatId: string) => boolean;
}

export interface SessionControllerOptions {
  emit: (event: EventCreateRequest) => void;
  now: () => number;
  /**
   * Simulated-response model. Required, so a missing wiring is a type error
   * rather than a silently inert feature; an unavailable scenario is expressed
   * by config, never by absence.
   */
  response: ResponseSimulationOptions;
  /**
   * Enables the idle auto-request automation: shortly after a contact is
   * classified, a proposal is requested on the trainee's behalf. Defaults to
   * on for live sessions; deterministic tests opt out. The controller itself
   * never approves and never submits the scored response. In AI-assisted mode
   * the external assistant driver requests *and* approves the simulated
   * measure (recorded with `auto: true`), a documented mode-scoped exception;
   * see docs/modules/ai_assisted_mode.md.
   */
  autoRequest?: boolean;
  /**
   * AI-assisted mode: the decision assistant runs the loop, so every decision
   * this session records carries `aid: "assisted"` provenance and the session
   * is labelled. Scoring and the state-machine gates are untouched: the
   * assistant acts through the very same methods a trainee clicks.
   */
  assisted?: boolean;
  /** Schedules an approved simulation's resolution. Injectable for tests. */
  schedule?: (run: () => void, delayMs: number) => unknown;
  /** Cancels a scheduled resolution. */
  unschedule?: (handle: unknown) => void;
}

export class SessionController {
  readonly scenario: { threats: PublicThreat[] };
  readonly sessionId: string;
  readonly traineeId: string;
  /** True when the AI decision assistant is driving this session. */
  readonly assisted: boolean;
  readonly events: EventCreateRequest[] = [];
  readonly threats: ThreatState[];
  status: SessionStatus = "active";

  private readonly emit: (event: EventCreateRequest) => void;
  private readonly now: () => number;
  private readonly response: ResponseSimulationOptions;
  private readonly schedule: (run: () => void, delayMs: number) => unknown;
  private readonly unschedule: (handle: unknown) => void;
  /** Simulated-response workflows, separate from the observation tracks. */
  private readonly responses = new ResponseBook();
  /** The trainee's own submitted assessment per contact, for proposal context. */
  private readonly assessments = new Map<string, ClassificationLabel>();
  /** Pending resolution handles per contact, so completion can cancel them. */
  private readonly responseTimers = new Map<string, unknown>();
  /** Pending idle auto-request handles per contact, so completion can cancel them. */
  private readonly autoRequestTimers = new Map<string, unknown>();
  /** Operator toggle for the idle auto-request automation. */
  private autoRequestEnabled: boolean;
  /**
   * Contacts whose simulated-response assistant was used (a proposal was
   * requested, whatever became of it). Read by respond() to stamp aid
   * provenance on the scored decision; never read by scoring.
   */
  private readonly simulationUsed = new Set<string>();

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
    this.response = options.response;
    this.schedule = options.schedule ?? ((run, delayMs) => setTimeout(run, delayMs));
    this.unschedule = options.unschedule
      ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.autoRequestEnabled = options.autoRequest ?? true;
    this.assisted = options.assisted ?? false;
    this.threats = scenario.threats.map((profile) => ({ profile, stage: "pending" }));
  }

  private threat(id: string): ThreatState | undefined {
    return this.threats.find((t) => t.profile.id === id);
  }

  private record(event: EventCreateRequest): void {
    this.events.push(event);
    this.emit(event);
  }

  /**
   * Decision provenance. In assisted mode every recorded decision is stamped
   * so the AAR can separate assistant decisions from operator decisions; in
   * manual mode payloads are unchanged and only the caller's evidence rides
   * along. An explicit `by` in the caller's provenance names the actual actor
   * (an operator override inside an assisted session); otherwise the assistant
   * is the actor. Payloads never influence scoring.
   */
  private decisionProvenance(
    provenance: Record<string, unknown>,
  ): Record<string, unknown> {
    if (!this.assisted) return provenance;
    const actor = typeof provenance.by === "string" ? provenance.by : "assistant";
    return { ...provenance, aid: "assisted", by: actor };
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
    this.record(events.threatDetected(id, this.now(), this.decisionProvenance(provenance)));
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
    // Kept only to quote the trainee's own assessment back in a proposal
    // basis; it is trainee-authored state, not ground truth.
    this.assessments.set(id, label);
    this.record(events.classification(id, label, this.now(), this.decisionProvenance(provenance)));
    // The idle automation gets one window to request a proposal; a manual
    // request, a response or session completion cancels or no-ops it.
    this.scheduleAutoRequest(id);
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
    // A responded contact can no longer be auto-requested; drop any pending
    // idle handle so it cannot fire later.
    this.clearAutoRequest(id);
    // Aid provenance for the AAR's Manual vs Assisted split: the decision
    // record itself says whether the simulated assistant was in play for this
    // contact. Scoring reads payload.response only, so this cannot change any
    // score, and the controller owns the value so callers cannot forge it.
    // In assisted mode the whole session is the assistant's, so every response
    // is stamped assisted regardless of the per-contact workflow history. An
    // explicit `by` names the actual actor for an operator override.
    const aid = this.assisted || this.simulationUsed.has(id) ? "assisted" : "manual";
    const actor = typeof provenance.by === "string" ? provenance.by : "assistant";
    const payload = this.assisted
      ? { ...provenance, aid, by: actor }
      : { ...provenance, aid };
    this.record(events.response(id, response, this.now(), payload));
    this.record(events.threatResolved(id, this.now()));
    return true;
  }

  /**
   * The simulated-response workflow for one contact, created on first query so
   * a contact never asked about stays inert. Undefined for unknown contacts.
   */
  responseWorkflow(id: string): ResponseWorkflow | undefined {
    if (this.threat(id) === undefined) return undefined;
    return this.responses.get(id) ?? this.responses.create(id, this.response.config);
  }

  /**
   * Request for a simulated response in one abstract class. Gated on the same
   * workflow the scored path already requires: the contact must have been
   * classified. The proposal is assembled from trainee-visible evidence only,
   * quoting back the trainee's own assessment -- it can never reveal the
   * expected response. `options.auto` marks the idle automation's request (it
   * changes only the recorded payload, never any gate).
   */
  requestResponse(
    id: string,
    tracked: boolean,
    responseClass: ResponseClass = "mitigation",
    options: { auto?: boolean } = {},
  ): boolean {
    const entry = this.threat(id);
    if (entry === undefined) return false;
    if (entry.stage !== "classified" && entry.stage !== "responded") return false;
    const assessment = this.assessments.get(id);
    if (assessment === undefined) return false;
    // Defensive invariant: never start a workflow that cannot resolve. Config
    // and resolver derive from the same public conditions, so a mismatch here
    // means the wiring drifted, and refusing beats a dangling approval.
    if (this.response.resolve(id) === null) return false;
    const workflow = this.responseWorkflow(id);
    if (workflow === undefined) return false;
    const proposal = buildProposal(
      { threat: entry.profile, assessment, tracked, responseClass },
      this.now(),
    );
    // buildProposal returns null for an unknown class, so a corrupted class
    // is refused here rather than silently becoming a mitigation.
    const next = applyAction(workflow, "request", this.now(), { proposal });
    if (next === null) return false;
    this.responses.set(next);
    this.simulationUsed.add(id);
    // A manual request supersedes any pending idle auto-request for the contact.
    this.clearAutoRequest(id);
    this.recordWorkflow(next, "proposal", options.auto === true ? { auto: true } : undefined);
    return true;
  }

  /**
   * Explicit operator approval. The outcome is resolved *before* approval so
   * an approved simulation can never strand without a result; approval then
   * schedules the resolution (event-driven, never polled) and the processing
   * state is what the trainee sees until the timer fires. `options.auto`
   * marks the assisted-mode driver's approval (recorded, never a gate change).
   */
  approveProposal(id: string, options: { auto?: boolean } = {}): boolean {
    const workflow = this.responses.get(id);
    if (workflow === undefined) return false;
    const outcome = this.response.resolve(id);
    if (outcome === null) return false;
    const next = applyAction(workflow, "approve", this.now());
    if (next === null) return false;
    this.responses.set(next);
    this.recordWorkflow(next, "approved", options.auto ? { auto: true } : undefined);
    this.responseTimers.set(
      id,
      this.schedule(() => this.resolveSimulation(id, outcome), RESPONSE_PROCESSING_MS),
    );
    return true;
  }

  rejectProposal(id: string): boolean {
    const workflow = this.responses.get(id);
    if (workflow === undefined) return false;
    const next = applyAction(workflow, "reject", this.now());
    if (next === null) return false;
    this.responses.set(next);
    this.recordWorkflow(next, "rejected");
    return true;
  }

  /**
   * Reopens a rejected proposal so the trainee can request again. Records
   * nothing: the reopen is a local reset, and the follow-up request logs its
   * own proposal record.
   */
  reopenProposal(id: string): boolean {
    const workflow = this.responses.get(id);
    if (workflow === undefined) return false;
    const next = applyAction(workflow, "reopen", this.now());
    if (next === null) return false;
    this.responses.set(next);
    return true;
  }

  /**
   * Operator toggle for the idle auto-request automation. Disabling cancels
   * pending auto-requests; contacts classified later are untouched.
   */
  setAutoRequestEnabled(enabled: boolean): void {
    this.autoRequestEnabled = enabled;
    if (enabled) return;
    for (const [id] of [...this.autoRequestTimers]) this.clearAutoRequest(id);
  }

  /**
   * Cancels an in-progress simulation before it resolves. The approval
   * decision stands and the cancellation is recorded; the simulation reaches
   * "aborted" with no result instead of a fabricated outcome.
   */
  cancelSimulation(id: string): boolean {
    const workflow = this.responses.get(id);
    if (workflow === undefined) return false;
    const next = applyAction(workflow, "cancel", this.now());
    if (next === null) return false;
    const timer = this.responseTimers.get(id);
    if (timer !== undefined) {
      this.unschedule(timer);
      this.responseTimers.delete(id);
    }
    this.responses.set(next);
    this.recordWorkflow(next, "cancelled");
    return true;
  }

  /**
   * Timer callback for an approved simulation. Deduplicated by construction:
   * a cancelled, resolved or completed workflow is no longer in_progress, so
   * a late or duplicate timer can never resolve it twice or emit twice.
   */
  private resolveSimulation(id: string, outcome: ResponseOutcome): void {
    this.responseTimers.delete(id);
    const workflow = this.responses.get(id);
    if (workflow === undefined || workflow.state !== "in_progress") return;
    const action = outcome.result === "neutralized" ? "succeed" : "fail";
    const next = applyAction(workflow, action, this.now(), { outcome });
    if (next === null) return;
    this.responses.set(next);
    this.recordWorkflow(next, "completed");
  }

  /**
   * Idle automation: one window after classification, an enabled session
   * requests a mitigation proposal on the trainee's behalf. The timer re-checks
   * every precondition when it fires, so a stale handle can never overwrite a
   * manual request, a response, or a new scenario. It never approves and never
   * submits the scored response -- those stay explicit operator actions.
   */
  private scheduleAutoRequest(id: string): void {
    if (!this.autoRequestEnabled) return;
    this.clearAutoRequest(id);
    this.autoRequestTimers.set(id, this.schedule(() => {
      this.autoRequestTimers.delete(id);
      if (!this.autoRequestEnabled || this.status !== "active") return;
      const threat = this.threat(id);
      if (threat === undefined || threat.stage !== "classified") return;
      const workflow = this.responseWorkflow(id);
      if (workflow === undefined || workflow.state !== "ready") return;
      this.requestResponse(id, this.response.tracked?.(id) ?? false, "mitigation", { auto: true });
    }, AUTO_REQUEST_MS));
  }

  private clearAutoRequest(id: string): void {
    const handle = this.autoRequestTimers.get(id);
    if (handle === undefined) return;
    this.unschedule(handle);
    this.autoRequestTimers.delete(id);
  }

  /**
   * Records one workflow phase as an event. Refuses once the session is no
   * longer active -- the backend rejects events after SESSION_COMPLETED -- and
   * refuses a phase the workflow cannot describe, so the history stays
   * trustworthy and no workflow event can leak past completion.
   */
  private recordWorkflow(
    workflow: ResponseWorkflow,
    phase: ResponseWorkflowPhase,
    extra: { auto?: boolean } = {},
  ): void {
    if (this.status !== "active") return;
    const payload = workflowEventPayload(workflow, phase);
    if (payload === null) return;
    this.record(events.responseWorkflow(this.now(), { ...payload, ...extra }));
  }

  falseAlarm(): void {
    this.record(events.falseAlarm(this.now()));
  }

  complete(): void {
    if (this.status !== "active") return;
    this.status = "completing";
    // A pending idle auto-request never fires past completion either.
    for (const [id] of [...this.autoRequestTimers]) this.clearAutoRequest(id);
    // A simulation still processing when the session ends never resolves:
    // cancel its timer and abort it locally, recording nothing, because a
    // post-completion event is refused by the backend and "session ended" is
    // not a phase the event vocabulary claims. This keeps completion/event
    // flush ordering and monotonic timestamps exactly as before.
    for (const [id, handle] of [...this.responseTimers]) {
      this.unschedule(handle);
      this.responseTimers.delete(id);
      const workflow = this.responses.get(id);
      if (workflow !== undefined && workflow.state === "in_progress") {
        const aborted = applyAction(workflow, "cancel", this.now());
        if (aborted !== null) this.responses.set(aborted);
      }
    }
    this.record(events.sessionCompleted(this.now()));
  }
}
