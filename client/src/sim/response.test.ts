import { describe, expect, it } from "vitest";
import type { PublicThreat } from "../api/types";
import {
  MIN_SENSOR_QUALITY,
  RESPONSE_PROCESSING_MS,
  RESPONSE_WORKFLOW_KEY,
  ResponseBook,
  SIMULATED_MEASURE,
  SIMULATED_WEAPON_MEASURE,
  TERMINAL_STATES,
  applyAction,
  buildProposal,
  canApply,
  canResolve,
  createWorkflow,
  invalidActionPayload,
  isResponseClass,
  isTerminal,
  nextState,
  responseConfigFor,
  resolveResponseOutcome,
  simulationSuccessChance,
  workflowEventPayload,
  type ResponseAction,
  type ResponseClass,
  type ResponseConditions,
  type ResponseState,
  type ResponseWorkflow,
} from "./response";

const GOOD = { sensor_quality: 0.9, visibility: "clear" as const };
const POOR = { sensor_quality: 0.4, visibility: "poor" as const };
const SCENARIO = { seed: 7, ...GOOD };

function threat(id = "T01", over: Partial<PublicThreat> = {}): PublicThreat {
  return {
    id,
    spawn_time: 10,
    speed_class: "fast",
    visibility_class: "clear",
    flight_pattern: "wide-weave",
    behavior: "erratic",
    cue_clear: true,
    swarm_id: null,
    swarm_index: null,
    ...over,
  };
}

function workflow(): ResponseWorkflow {
  return createWorkflow("T01", responseConfigFor(GOOD));
}

function proposed(wf: ResponseWorkflow = workflow(), atMs = 1000): ResponseWorkflow {
  return applyAction(wf, "request", atMs, {
    proposal: buildProposal({
      threat: threat(), assessment: "hostile", tracked: true, responseClass: "mitigation",
    }, atMs),
  })!;
}

function inProgress(wf: ResponseWorkflow = proposed(), atMs = 1500): ResponseWorkflow {
  return applyAction(wf, "approve", atMs)!;
}

describe("response state machine", () => {
  const states: ResponseState[] = [
    "unavailable", "ready", "awaiting_approval", "in_progress",
    "neutralized", "failed", "aborted", "rejected",
  ];

  it("models all eight required states", () => {
    expect(states).toHaveLength(8);
    expect(new Set(states).size).toBe(8);
  });

  it("follows the approved happy path", () => {
    expect(nextState("ready", "request")).toBe("awaiting_approval");
    expect(nextState("awaiting_approval", "approve")).toBe("in_progress");
    expect(nextState("in_progress", "succeed")).toBe("neutralized");
    expect(nextState("in_progress", "fail")).toBe("failed");
    expect(nextState("in_progress", "cancel")).toBe("aborted");
    expect(nextState("awaiting_approval", "reject")).toBe("rejected");
    expect(nextState("rejected", "reopen")).toBe("ready");
  });

  it("refuses every action from terminal states", () => {
    for (const state of TERMINAL_STATES) {
      const actions: ResponseAction[] = ["request", "approve", "reject", "succeed", "fail", "cancel", "reopen"];
      for (const action of actions) {
        expect(canApply(state, action)).toBe(false);
      }
      expect(isTerminal(state)).toBe(true);
    }
  });

  it("refuses invalid and skipped transitions", () => {
    expect(nextState("unavailable", "request")).toBeNull();
    expect(nextState("ready", "approve")).toBeNull();
    expect(nextState("ready", "cancel")).toBeNull();
    expect(nextState("awaiting_approval", "succeed")).toBeNull();
    expect(nextState("in_progress", "request")).toBeNull();
    expect(nextState("in_progress", "approve")).toBeNull();
    expect(nextState("rejected", "approve")).toBeNull();
    expect(nextState("neutralized", "reopen")).toBeNull();
    expect(canApply("in_progress", "succeed")).toBe(true);
    expect(isTerminal("ready")).toBe(false);
  });

  it("cannot start a workflow when the scenario cannot resolve one", () => {
    const blocked = createWorkflow("T01", responseConfigFor(POOR));
    expect(blocked.state).toBe("unavailable");
    expect(applyAction(blocked, "request", 1000)).toBeNull();
  });
});

describe("workflow application guards", () => {
  it("records the proposal, decision and resolution timestamps", () => {
    const wf = inProgress();
    expect(wf.state).toBe("in_progress");
    expect(wf.proposedAtMs).toBe(1000);
    expect(wf.decisionMs).toBe(1500);
    expect(wf.startedAtMs).toBe(1500);
    const done = applyAction(wf, "succeed", 1500 + RESPONSE_PROCESSING_MS, {
      outcome: resolveResponseOutcome(SCENARIO, "T01"),
    })!;
    expect(done.state).toBe("neutralized");
    expect(done.resolvedAtMs).toBe(1500 + RESPONSE_PROCESSING_MS);
  });

  it("refuses duplicate approvals and duplicate submissions", () => {
    const wf = inProgress();
    expect(applyAction(wf, "approve", 1600)).toBeNull();
    const outcome = resolveResponseOutcome(SCENARIO, "T01")!;
    const done = applyAction(wf, "succeed", 3500, { outcome })!;
    expect(applyAction(done, "succeed", 3600, { outcome })).toBeNull();
    expect(applyAction(done, "fail", 3600, { outcome })).toBeNull();
    expect(applyAction(done, "cancel", 3600)).toBeNull();
  });

  it("refuses a second request and a request without a proposal", () => {
    const wf = proposed();
    expect(applyAction(wf, "request", 1100)).toBeNull();
    expect(applyAction(workflow(), "request", 1000, {})).toBeNull();
  });

  it("refuses premature and stale resolutions", () => {
    const wf = inProgress();
    const outcome = resolveResponseOutcome(SCENARIO, "T01")!;
    expect(canResolve(wf, 1500 + RESPONSE_PROCESSING_MS - 1)).toBe(false);
    expect(canResolve(wf, 1500 + RESPONSE_PROCESSING_MS)).toBe(true);
    expect(applyAction(wf, "succeed", 1500 + RESPONSE_PROCESSING_MS - 1, { outcome })).toBeNull();
    expect(applyAction(wf, "succeed", 1400, { outcome })).toBeNull();
    expect(applyAction(wf, "succeed", 3500, {})).toBeNull();
    expect(canResolve(proposed(), 9999)).toBe(false);
    expect(canResolve(workflow(), 9999)).toBe(false);
  });

  it("keeps a rejected proposal reopenable and clears the stale proposal", () => {
    const rejected = applyAction(proposed(), "reject", 1600)!;
    expect(rejected.state).toBe("rejected");
    const reopened = applyAction(rejected, "reopen", 1700)!;
    expect(reopened.state).toBe("ready");
    expect(reopened.proposal).toBeNull();
    expect(reopened.proposedAtMs).toBeNull();
  });

  it("never mutates the workflow it is given", () => {
    const before = workflow();
    const snapshot = JSON.stringify(before);
    applyAction(before, "request", 1000, {
      proposal: buildProposal({
        threat: threat(), assessment: "suspicious", tracked: false, responseClass: "mitigation",
      }, 1000),
    });
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it("cancels an approved simulation while the decision stands", () => {
    const aborted = applyAction(inProgress(), "cancel", 2000)!;
    expect(aborted.state).toBe("aborted");
    expect(aborted.decisionMs).toBe(1500);
    expect(aborted.outcome).toBeNull();
    expect(aborted.resolvedAtMs).toBe(2000);
  });
});

describe("scenario configuration", () => {
  it("is available above the sensor fidelity threshold", () => {
    expect(responseConfigFor(GOOD)).toEqual({ available: true, reason: null });
    expect(responseConfigFor({ sensor_quality: MIN_SENSOR_QUALITY, visibility: "poor" }).available).toBe(true);
  });

  it("explains itself instead of inventing an outcome below the threshold", () => {
    const config = responseConfigFor(POOR);
    expect(config.available).toBe(false);
    expect(config.reason).toContain("unavailable");
    expect(resolveResponseOutcome({ seed: 7, ...POOR }, "T01")).toBeNull();
    const blocked = createWorkflow("T01", config);
    expect(blocked.state).toBe("unavailable");
    expect(blocked.reason).toBe(config.reason);
  });
});

describe("deterministic outcome", () => {
  // Golden vectors: a fixed seed with fixed public conditions must always
  // resolve the same way per contact. Each set contains both outcomes, so the
  // vectors cannot silently collapse into a constant.
  const CLEAR = { seed: 7, sensor_quality: 0.9, visibility: "clear" as const };
  const MARGINAL = { seed: 7, sensor_quality: 0.5, visibility: "clear" as const };
  const DEGRADED = { seed: 7, sensor_quality: 0.7, visibility: "poor" as const };
  const MIXED = ["failed", "failed", "failed", "failed", "neutralized", "failed", "neutralized", "failed"];
  const VECTORS = ["T01", "T02", "T03", "T04", "T05", "T06", "T07", "T08"];

  const vector = (scenario: ResponseConditions & { seed: number }) => VECTORS.map(
    (id) => resolveResponseOutcome(scenario, id)!.result,
  );

  it("pins the golden vectors for controlled inputs", () => {
    expect(vector(CLEAR)).toEqual([
      "failed", "failed", "failed", "neutralized", "neutralized", "neutralized", "neutralized", "neutralized",
    ]);
    expect(vector(MARGINAL)).toEqual(MIXED);
    expect(vector(DEGRADED)).toEqual(MIXED);
  });

  it("resolves an exact success and an exact failure under controlled inputs", () => {
    expect(resolveResponseOutcome(CLEAR, "T04")).toEqual({
      result: "neutralized",
      cause: "The simulated measure resolved under clear visibility and high sensor fidelity.",
    });
    expect(resolveResponseOutcome(CLEAR, "T01")).toEqual({
      result: "failed",
      cause: "The simulated measure did not resolve under clear visibility and high sensor fidelity.",
    });
    expect(resolveResponseOutcome(DEGRADED, "T05")).toEqual({
      result: "neutralized",
      cause: "The simulated measure resolved under poor visibility and moderate sensor fidelity.",
    });
  });

  it("is stable for the same scenario and contact", () => {
    const first = resolveResponseOutcome(SCENARIO, "T01");
    for (let i = 0; i < 5; i += 1) {
      expect(resolveResponseOutcome(SCENARIO, "T01")).toEqual(first);
    }
  });

  it("varies per contact and per seed", () => {
    // Marginal public conditions (an even coin) so both outcomes really occur.
    const balanced = { seed: 7, sensor_quality: MIN_SENSOR_QUALITY, visibility: "clear" as const };
    const contacts = new Set(
      ["T01", "T02", "T03", "T04", "T05", "T06", "T07", "T08"]
        .map((id) => resolveResponseOutcome(balanced, id)!.result),
    );
    expect(contacts.size).toBeGreaterThan(1);
    const seeds = new Set(
      [1, 2, 3, 4, 5].map((seed) => resolveResponseOutcome({ ...balanced, seed }, "T01")!.result),
    );
    expect(seeds.size).toBeGreaterThan(1);
  });

  it("reports higher resolution weighting in better public conditions", () => {
    const clear = simulationSuccessChance(GOOD);
    const reduced = simulationSuccessChance({ sensor_quality: 0.9, visibility: "reduced" });
    const poor = simulationSuccessChance({ sensor_quality: 0.9, visibility: "poor" });
    const weak = simulationSuccessChance({ sensor_quality: 0.55, visibility: "clear" });
    expect(clear).toBeGreaterThan(reduced);
    expect(reduced).toBeGreaterThan(poor);
    expect(clear).toBeGreaterThan(weak);
    for (const chance of [clear, reduced, poor, weak]) {
      expect(chance).toBeGreaterThan(0);
      expect(chance).toBeLessThan(1);
    }
  });

  it("never varies with the trainee's assessment", () => {
    // The outcome reads public conditions and the seed only, so a mistaken
    // assessment cannot be rewarded or punished through the simulation.
    const assessments = ["friendly", "civilian", "unknown", "suspicious", "hostile"] as const;
    const outcomes = assessments.map((assessment) => {
      const wf = applyAction(workflow(), "request", 1000, {
        proposal: buildProposal({
          threat: threat(), assessment, tracked: true, responseClass: "mitigation",
        }, 1000),
      })!;
      expect(wf.proposal!.basis).toContain(assessment);
      return resolveResponseOutcome(SCENARIO, "T01");
    });
    for (const outcome of outcomes) {
      expect(outcome).toEqual(resolveResponseOutcome(SCENARIO, "T01"));
    }
  });

  it("describes the outcome in non-numeric, simulation-only language", () => {
    for (let id = 0; id < 40; id += 1) {
      const outcome = resolveResponseOutcome(SCENARIO, `T0${id}`)!;
      expect(outcome.cause).toMatch(/simulated measure/);
      expect(outcome.cause).toMatch(/visibility/);
      expect(outcome.cause).not.toMatch(/\d/);
      expect(outcome.result === "neutralized" || outcome.result === "failed").toBe(true);
    }
  });
});

describe("proposal evidence", () => {
  it("quotes only observable context and the trainee's own assessment", () => {
    const proposal = buildProposal({
      threat: threat(), assessment: "suspicious", tracked: true, responseClass: "mitigation",
    }, 1000)!;
    expect(proposal.measure).toBe(SIMULATED_MEASURE);
    expect(proposal.responseClass).toBe("mitigation");
    expect(proposal.requestedAtMs).toBe(1000);
    expect(proposal.basis).toContain("suspicious");
    expect(proposal.basis).toContain("wide-weave");
    expect(proposal.basis).toContain("erratic");
    const text = JSON.stringify(proposal);
    for (const forbidden of ["classification_label", "expected_response"]) {
      expect(text).not.toContain(forbidden);
    }
  });

  it("names a weapon-class request as an abstract authorization decision", () => {
    const proposal = buildProposal({
      threat: threat(), assessment: "hostile", tracked: true, responseClass: "weapon-class",
    }, 1000)!;
    expect(proposal.measure).toBe(SIMULATED_WEAPON_MEASURE);
    expect(proposal.responseClass).toBe("weapon-class");
    expect(proposal.measure).toContain("simulated");
    expect(proposal.measure).toContain("authorization");
    expect(proposal.basis).toContain("abstract training decision");
    expect(proposal.basis).toContain("nothing is executed");
  });

  it("refuses an unknown response class instead of guessing one", () => {
    const bogus = buildProposal({
      threat: threat(),
      assessment: "hostile",
      tracked: true,
      responseClass: "kinetic" as unknown as ResponseClass,
    }, 1000);
    expect(bogus).toBeNull();
    expect(isResponseClass("mitigation")).toBe(true);
    expect(isResponseClass("weapon-class")).toBe(true);
    expect(isResponseClass("kinetic")).toBe(false);
    expect(isResponseClass(undefined)).toBe(false);
  });

  it("keeps every class string abstract and simulation-only", () => {
    const forbidden = ["fire", "target", "intercept", "engage", "trajectory", "pursuit", "kill", "strike"];
    const proposals = (["mitigation", "weapon-class"] as const).map((responseClass) => buildProposal({
      threat: threat(), assessment: "hostile", tracked: true, responseClass,
    }, 1000)!);
    for (const proposal of proposals) {
      expect(proposal.measure).toContain("simulated");
      const text = `${proposal.measure} ${proposal.basis}`.toLowerCase();
      for (const word of forbidden) expect(text).not.toContain(word);
    }
  });

  it("stays honest when nothing is tracked or the signature is unreadable", () => {
    const proposal = buildProposal({
      threat: threat("T02", { behavior: "indeterminate", flight_pattern: null }),
      assessment: "unknown",
      tracked: false,
      responseClass: "mitigation",
    }, 500)!;
    expect(proposal.basis).toContain("no track is currently held");
    expect(proposal.basis).not.toContain("signature");
    expect(proposal.basis).not.toContain("flying");
  });
});

describe("response book", () => {
  it("stores workflows per contact and clears them for a new scenario", () => {
    const book = new ResponseBook();
    book.create("T01", responseConfigFor(GOOD));
    book.create("T02", responseConfigFor(POOR));
    expect(book.size).toBe(2);
    expect(book.get("T01")!.state).toBe("ready");
    expect(book.get("T02")!.state).toBe("unavailable");
    book.reset();
    expect(book.size).toBe(0);
    expect(book.get("T01")).toBeUndefined();
  });

  it("keeps the stored workflow in step with the session", () => {
    const book = new ResponseBook();
    book.create("T01", responseConfigFor(GOOD));
    book.set(inProgress(proposed(book.get("T01")!)));
    expect(book.get("T01")!.state).toBe("in_progress");
  });
});

describe("workflow event payloads", () => {
  it("describes each phase the workflow has entered", () => {
    const requested = proposed();
    const proposal = workflowEventPayload(requested, "proposal")!;
    expect(proposal.workflow).toBe(RESPONSE_WORKFLOW_KEY);
    expect(proposal.phase).toBe("proposal");
    expect(proposal.threat).toBe("T01");
    expect(proposal.measure).toBe(SIMULATED_MEASURE);
    expect(proposal.response_class).toBe("mitigation");
    expect(proposal.proposal_ms).toBe(1000);

    const approved = inProgress(requested);
    const approval = workflowEventPayload(approved, "approved")!;
    expect(approval.phase).toBe("approved");
    expect(approval.decision_ms).toBe(1500);
    expect(approval.started_ms).toBe(1500);

    const resolved = resolveResponseOutcome(SCENARIO, "T01")!;
    const completed = applyAction(
      approved,
      resolved.result === "neutralized" ? "succeed" : "fail",
      3500,
      { outcome: resolved },
    )!;
    const done = workflowEventPayload(completed, "completed")!;
    expect(done.outcome).toBe(resolved.result);
    expect(done.cause).toContain("simulated measure");
    expect(done.resolved_ms).toBe(3500);
  });

  it("records rejection and cancellation", () => {
    const rejected = applyAction(proposed(), "reject", 1600)!;
    expect(workflowEventPayload(rejected, "rejected")!.decision_ms).toBe(1600);
    const aborted = applyAction(inProgress(), "cancel", 2000)!;
    const cancelled = workflowEventPayload(aborted, "cancelled")!;
    expect(cancelled.phase).toBe("cancelled");
    expect(cancelled.outcome).toBeUndefined();
  });

  it("carries the requested class through every phase", () => {
    const weapon = applyAction(workflow(), "request", 1000, {
      proposal: buildProposal({
        threat: threat(), assessment: "hostile", tracked: true, responseClass: "weapon-class",
      }, 1000),
    })!;
    const proposal = workflowEventPayload(weapon, "proposal")!;
    expect(proposal.measure).toBe(SIMULATED_WEAPON_MEASURE);
    expect(proposal.response_class).toBe("weapon-class");
    const approved = workflowEventPayload(applyAction(weapon, "approve", 1500)!, "approved")!;
    expect(approved.response_class).toBe("weapon-class");
  });

  it("refuses payloads for phases the workflow never entered", () => {
    const wf = proposed();
    expect(workflowEventPayload(wf, "approved")).toBeNull();
    expect(workflowEventPayload(wf, "completed")).toBeNull();
    expect(workflowEventPayload(wf, "cancelled")).toBeNull();
    expect(workflowEventPayload(inProgress(wf), "proposal")).toBeNull();
    expect(workflowEventPayload(wf, "invalid")).toBeNull();
    expect(workflowEventPayload(createWorkflow("T01", responseConfigFor(POOR)), "proposal")).toBeNull();
  });

  it("records a refused action without naming any ground truth", () => {
    const payload = invalidActionPayload("T01", "contact is not classified yet");
    expect(payload.phase).toBe("invalid");
    expect(payload.cause).toBe("contact is not classified yet");
    expect(JSON.stringify(payload)).not.toContain("classification_label");
  });
});