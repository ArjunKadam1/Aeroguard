// Simulated response model: the neutralization *simulation* workflow.
//
// Scope: this resolves an abstract simulated measure against an observed
// contact, for training only. There is no targeting, no weapon or intercept
// mechanic, no pursuit logic and no engagement envelope anywhere in this file,
// and a resolved outcome says nothing about any real contact. The wording in
// here is deliberately "simulated measure" rather than "engagement" so no
// trainee-facing string can imply a real contact was eliminated.
//
// Response classes ("mitigation", "weapon-class") select the wording of an
// authorization request only. "weapon-class" is an abstract training decision:
// it changes no mechanic, adds no targeting or firing behaviour, and no
// trainee-facing string claims any real system acted.
//
// Deliberately orthogonal to the scored response. The trainee's ExpectedResponse
// stays where it already is: SessionController.respond, in the Respond stage.
// Approving a proposal here never submits or implies a scored response, which
// keeps the scoring formulas untouched and keeps the response answer key out of
// the trainee's hands. LABEL_TO_RESPONSE is server ground truth and is
// intentionally NOT mirrored in the client: reusing it to build a proposal
// would leak the expected response and auto-score it on approval.
//
// Every decision is a pure function of trainee-visible data: the redacted
// PublicScenario (seed, sensor quality, visibility), the observable contact,
// and the trainee's own assessment. Hidden attributes are unreachable by
// construction -- no function here accepts a server label, only the label the
// trainee themselves submitted, and only to quote it back as context.
//
// Pure module: no DOM, no Three.js, no session state. The workflow is a
// separate response-status model so the observation track lifecycle
// (tentative -> confirmed -> coasting -> dropped) is never overloaded with a
// neutralization state.

import type { ClassificationLabel, PublicThreat, Visibility } from "../api/types";
import { roll01 } from "./observation";

// --- States -------------------------------------------------------------------
// unavailable        the scenario cannot resolve a simulated response
// ready              a simulated response may be requested, under existing gates
// awaiting_approval  a proposal is waiting for explicit operator approval
// in_progress        an approved simulation is processing
// neutralized        the simulation resolved successfully
// failed             the simulation did not resolve
// aborted            an approved simulation was cancelled before it resolved
// rejected           the trainee rejected the proposal

export type ResponseState =
  | "unavailable"
  | "ready"
  | "awaiting_approval"
  | "in_progress"
  | "neutralized"
  | "failed"
  | "aborted"
  | "rejected";

export type ResponseAction =
  | "request"
  | "approve"
  | "reject"
  | "succeed"
  | "fail"
  | "cancel"
  | "reopen";

const TRANSITIONS: Readonly<
  Record<ResponseState, Readonly<Partial<Record<ResponseAction, ResponseState>>>>
> = {
  unavailable: {},
  ready: { request: "awaiting_approval" },
  awaiting_approval: { approve: "in_progress", reject: "rejected" },
  in_progress: { succeed: "neutralized", fail: "failed", cancel: "aborted" },
  neutralized: {},
  failed: {},
  aborted: {},
  rejected: { reopen: "ready" },
};

/** States that resolve the workflow; nothing further is possible afterwards. */
export const TERMINAL_STATES: readonly ResponseState[] = ["neutralized", "failed", "aborted"];

export function isTerminal(state: ResponseState): boolean {
  return TERMINAL_STATES.includes(state);
}

/** The state an action leads to, or null when the action is not allowed. */
export function nextState(state: ResponseState, action: ResponseAction): ResponseState | null {
  return TRANSITIONS[state][action] ?? null;
}

export function canApply(state: ResponseState, action: ResponseAction): boolean {
  return nextState(state, action) !== null;
}

// --- Scenario configuration ---------------------------------------------------

/** Public sensor conditions the workflow reads. Narrow on purpose. */
export type ResponseConditions = {
  sensor_quality: number;
  visibility: Visibility;
};

/**
 * Below this sensor fidelity the simulation cannot resolve an outcome. The
 * workflow reports "unavailable" and explains itself instead of inventing one.
 */
export const MIN_SENSOR_QUALITY = 0.5;

export interface ResponseConfig {
  available: boolean;
  /** Trainee-safe explanation, present exactly when unavailable. */
  reason: string | null;
}

const UNAVAILABLE_REASON =
  "Simulated response resolution is unavailable: sensor fidelity is below the "
  + "simulation threshold for this scenario.";

export function responseConfigFor(conditions: ResponseConditions): ResponseConfig {
  if (conditions.sensor_quality < MIN_SENSOR_QUALITY) {
    return { available: false, reason: UNAVAILABLE_REASON };
  }
  return { available: true, reason: null };
}

// --- Deterministic outcome ----------------------------------------------------
// How long an approved simulation takes to resolve, in session milliseconds.
// The response decision is already recorded at approval; this is only the
// simulation's own processing time, so it never shifts any scored timing.
export const RESPONSE_PROCESSING_MS = 2000;

/**
 * Idle window after a contact is classified before the automation (when the
 * operator has it enabled) requests a proposal on the trainee's behalf. This
 * automates the *request* only: approval and the scored response are always an
 * explicit operator action.
 */
export const AUTO_REQUEST_MS = 10000;

const VISIBILITY_PENALTY: Record<Visibility, number> = {
  clear: 0,
  reduced: 0.08,
  poor: 0.18,
};

/**
 * Internal resolution weighting derived from public conditions. It is never
 * rendered: the interface must not show the trainee a success probability,
 * which would be a fabricated confidence value.
 */
export function simulationSuccessChance(conditions: ResponseConditions): number {
  // Centred on an even coin at the availability floor (sensor_quality 0.5,
  // clear), so a marginal scenario still produces both outcomes across
  // contacts; fidelity raises it and visibility loss lowers it.
  const base = 0.5 + (conditions.sensor_quality - 0.5) * 0.8;
  const chance = base - VISIBILITY_PENALTY[conditions.visibility];
  return Math.max(0.05, Math.min(0.95, chance));
}

const FIDELITY_TIERS: Array<{ above: number; word: string }> = [
  { above: 0.8, word: "high sensor fidelity" },
  { above: 0.6, word: "moderate sensor fidelity" },
  { above: 0, word: "low sensor fidelity" },
];

function conditionPhrase(conditions: ResponseConditions): string {
  const fidelity = FIDELITY_TIERS.find((tier) => conditions.sensor_quality > tier.above);
  const visibility = `${conditions.visibility} visibility`;
  return `${visibility} and ${fidelity ? fidelity.word : "low sensor fidelity"}`;
}

export type ResponseOutcomeResult = "neutralized" | "failed";

export interface ResponseOutcome {
  result: ResponseOutcomeResult;
  /**
   * Trainee-safe, non-numeric explanation. It describes public conditions and
   * whether the simulation resolved -- never a probability and never a claim
   * about the contact's real classification.
   */
  cause: string;
}

/**
 * Resolve the simulated outcome deterministically: a keyed roll against the
 * public-condition weighting, so the same scenario and contact always resolve
 * the same way (replayable, testable, seed-stable). Returns null when the
 * scenario has no usable response parameters -- the caller must then explain
 * that resolution is unavailable rather than fabricate a result.
 */
export function resolveResponseOutcome(
  scenario: ResponseConditions & { seed: number },
  threatId: string,
): ResponseOutcome | null {
  if (!responseConfigFor(scenario).available) return null;
  const conditions = conditionPhrase(scenario);
  const resolved = roll01(`${scenario.seed}|response-simulation|${threatId}`)
    < simulationSuccessChance(scenario);
  return {
    result: resolved ? "neutralized" : "failed",
    cause: resolved
      ? `The simulated measure resolved under ${conditions}.`
      : `The simulated measure did not resolve under ${conditions}.`,
  };
}

// --- Proposal -----------------------------------------------------------------

/**
 * Abstract response classes the trainee can authorize. The class selects only
 * how the simulated measure is *named*: "weapon-class" is an authorization
 * decision, and there is no firing, targeting, trajectory or engagement
 * mechanic behind either class anywhere in this module.
 */
export type ResponseClass = "mitigation" | "weapon-class";

export const RESPONSE_CLASSES: readonly ResponseClass[] = ["mitigation", "weapon-class"];

/** Abstract, simulation-only measure names. Never a weapon or an interceptor. */
export const SIMULATED_MEASURE = "simulated controlled mitigation";
export const SIMULATED_WEAPON_MEASURE = "simulated weapon-class authorization";

const CLASS_MEASURES: Readonly<Record<ResponseClass, string>> = {
  mitigation: SIMULATED_MEASURE,
  "weapon-class": SIMULATED_WEAPON_MEASURE,
};

export function isResponseClass(value: unknown): value is ResponseClass {
  return typeof value === "string" && (RESPONSE_CLASSES as readonly string[]).includes(value);
}

export interface ProposalEvidence {
  /** Observable contact. Carries no classification, by type. */
  threat: PublicThreat;
  /** The trainee's own submitted assessment, quoted back as context only. */
  assessment: ClassificationLabel;
  /** Whether a sensor track currently holds the contact. */
  tracked: boolean;
  /** Which abstract response class to request. */
  responseClass: ResponseClass;
}

export interface ResponseProposal {
  measure: string;
  /** The abstract class this proposal authorizes. */
  responseClass: ResponseClass;
  /** Plain-language, trainee-visible reasons for the proposal. */
  basis: string;
  requestedAtMs: number;
}

/**
 * Builds the proposal for an abstract, simulated response class, or null when
 * the requested class is not one of the known classes. Refusing an unknown
 * class keeps a corrupted request from silently becoming a mitigation.
 */
export function buildProposal(evidence: ProposalEvidence, atMs: number): ResponseProposal | null {
  if (!isResponseClass(evidence.responseClass)) return null;
  const { threat } = evidence;
  const parts = [
    `you assessed ${threat.id} as ${evidence.assessment}`,
    evidence.tracked ? "a sensor track is held" : "no track is currently held",
  ];
  if (threat.flight_pattern) parts.push(`it is flying ${threat.flight_pattern}`);
  if (threat.behavior && threat.behavior !== "indeterminate") {
    parts.push(`its signature reads ${threat.behavior}`);
  }
  const classNote = evidence.responseClass === "weapon-class"
    ? " Weapon-class authorization is an abstract training decision; nothing is executed."
    : "";
  return {
    measure: CLASS_MEASURES[evidence.responseClass],
    responseClass: evidence.responseClass,
    basis: `Proposed from what you can observe: ${parts.join("; ")}.${classNote}`,
    requestedAtMs: atMs,
  };
}

// --- Workflow -----------------------------------------------------------------

export interface ResponseWorkflow {
  threatId: string;
  state: ResponseState;
  proposal: ResponseProposal | null;
  proposedAtMs: number | null;
  /** Operator approve/reject decision, or null until one is made. */
  decisionMs: number | null;
  startedAtMs: number | null;
  /** Terminal timestamp, including cancellation. */
  resolvedAtMs: number | null;
  outcome: ResponseOutcome | null;
  /** Why the workflow is unavailable, when it is. */
  reason: string | null;
}

export function createWorkflow(threatId: string, config: ResponseConfig): ResponseWorkflow {
  return {
    threatId,
    state: config.available ? "ready" : "unavailable",
    proposal: null,
    proposedAtMs: null,
    decisionMs: null,
    startedAtMs: null,
    resolvedAtMs: null,
    outcome: null,
    reason: config.available ? null : config.reason,
  };
}

export interface ActionOptions {
  // Nullable on purpose: callers pass resolveResponseOutcome() straight
  // through, and a null (unresolvable) outcome is refused rather than faked.
  proposal?: ResponseProposal | null;
  outcome?: ResponseOutcome | null;
}

/** Latest timestamp already recorded, used to refuse stale or out-of-order actions. */
function latestMs(workflow: ResponseWorkflow): number {
  return Math.max(
    workflow.proposedAtMs ?? 0,
    workflow.decisionMs ?? 0,
    workflow.startedAtMs ?? 0,
    workflow.resolvedAtMs ?? 0,
    workflow.proposal ? workflow.proposal.requestedAtMs : 0,
  );
}

/** An approved simulation resolves only after its processing time has passed. */
export function canResolve(workflow: ResponseWorkflow, nowMs: number): boolean {
  if (workflow.state !== "in_progress" || workflow.startedAtMs === null) return false;
  return nowMs - workflow.startedAtMs >= RESPONSE_PROCESSING_MS;
}

/**
 * Apply an action, returning a new workflow, or null when the action is not
 * valid. A null result is the refusal path: repeated clicks, duplicate
 * submissions, out-of-order transitions and stale timestamps all leave the
 * workflow untouched instead of running the simulation twice.
 */
export function applyAction(
  workflow: ResponseWorkflow,
  action: ResponseAction,
  atMs: number,
  options: ActionOptions = {},
): ResponseWorkflow | null {
  const next = nextState(workflow.state, action);
  if (next === null) return null;
  if (!Number.isFinite(atMs) || atMs < latestMs(workflow)) return null;

  switch (action) {
    case "request": {
      if (!options.proposal) return null;
      return {
        ...workflow,
        state: next,
        proposal: options.proposal,
        proposedAtMs: atMs,
      };
    }
    case "approve":
      return {
        ...workflow,
        state: next,
        decisionMs: atMs,
        startedAtMs: atMs,
      };
    case "reject":
      return { ...workflow, state: next, decisionMs: atMs };
    case "succeed":
    case "fail": {
      if (!options.outcome || !canResolve(workflow, atMs)) return null;
      return {
        ...workflow,
        state: next,
        outcome: options.outcome,
        resolvedAtMs: atMs,
      };
    }
    case "cancel":
      return { ...workflow, state: next, resolvedAtMs: atMs };
    case "reopen":
      return { ...workflow, state: next, proposal: null, proposedAtMs: null };
  }
}

/**
 * Per-scenario store of response workflows, keyed by contact. Separate from the
 * observation tracks on purpose: a neutralized simulation never rewrites track
 * state. reset() drops everything, which is what a new scenario needs so no
 * workflow or notification can leak across scenarios.
 */
export class ResponseBook {
  private readonly workflows = new Map<string, ResponseWorkflow>();

  create(threatId: string, config: ResponseConfig): ResponseWorkflow {
    const workflow = createWorkflow(threatId, config);
    this.workflows.set(threatId, workflow);
    return workflow;
  }

  get(threatId: string): ResponseWorkflow | undefined {
    return this.workflows.get(threatId);
  }

  set(workflow: ResponseWorkflow): void {
    this.workflows.set(workflow.threatId, workflow);
  }

  reset(): void {
    this.workflows.clear();
  }

  get size(): number {
    return this.workflows.size;
  }
}

// --- Event payloads -----------------------------------------------------------
// Phase records for the event history. They carry no threat_id of their own:
// the caller submits them with a null threat_id, which the server accepts
// without threat validation and which scoring and AAR per-threat logic ignore
// (they match events on threat_id). That keeps the frozen v1 event contract and
// every scored formula untouched while still recording the workflow.

export const RESPONSE_WORKFLOW_KEY = "response-simulation";

export type ResponseWorkflowPhase =
  | "proposal"
  | "approved"
  | "rejected"
  | "cancelled"
  | "completed"
  | "invalid";

export interface ResponseWorkflowEventPayload {
  workflow: typeof RESPONSE_WORKFLOW_KEY;
  phase: ResponseWorkflowPhase;
  threat: string;
  measure?: string;
  /** Abstract class the proposal requested, when one exists. */
  response_class?: ResponseClass;
  /** True when the idle automation requested the proposal, not a click. */
  auto?: boolean;
  outcome?: ResponseOutcomeResult;
  cause?: string;
  proposal_ms?: number;
  decision_ms?: number;
  started_ms?: number;
  resolved_ms?: number;
}

/** Which states a phase describes. Explicit, because phase and state names differ. */
const PHASE_STATES: Readonly<
  Record<Exclude<ResponseWorkflowPhase, "invalid">, readonly ResponseState[]>
> = {
  proposal: ["awaiting_approval"],
  approved: ["in_progress"],
  rejected: ["rejected"],
  cancelled: ["aborted"],
  completed: ["neutralized", "failed"],
};

/**
 * Payload for a phase that the workflow has just entered, or null when the
 * workflow is not (or no longer) in a state that matches the phase. Refusing to
 * build an inconsistent payload keeps the event history trustworthy.
 */
export function workflowEventPayload(
  workflow: ResponseWorkflow,
  phase: ResponseWorkflowPhase,
): ResponseWorkflowEventPayload | null {
  if (phase === "invalid") return null;
  if (!PHASE_STATES[phase].includes(workflow.state)) return null;

  const payload: ResponseWorkflowEventPayload = {
    workflow: RESPONSE_WORKFLOW_KEY,
    phase,
    threat: workflow.threatId,
  };
  if (workflow.proposal) {
    payload.measure = workflow.proposal.measure;
    payload.response_class = workflow.proposal.responseClass;
  }
  if (workflow.outcome) {
    payload.outcome = workflow.outcome.result;
    payload.cause = workflow.outcome.cause;
  }
  if (workflow.proposedAtMs !== null) payload.proposal_ms = workflow.proposedAtMs;
  if (workflow.decisionMs !== null) payload.decision_ms = workflow.decisionMs;
  if (workflow.startedAtMs !== null) payload.started_ms = workflow.startedAtMs;
  if (workflow.resolvedAtMs !== null) payload.resolved_ms = workflow.resolvedAtMs;
  return payload;
}

/** Payload for a refused trainee action, recorded rather than silently dropped. */
export function invalidActionPayload(
  threatId: string,
  detail: string,
): ResponseWorkflowEventPayload {
  return { workflow: RESPONSE_WORKFLOW_KEY, phase: "invalid", threat: threatId, cause: detail };
}