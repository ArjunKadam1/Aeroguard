import { describe, expect, it } from "vitest";
import type { ClassificationLabel, EventCreateRequest, PublicThreat } from "../api/types";
import { AUTO_REQUEST_MS, RESPONSE_PROCESSING_MS, responseConfigFor, resolveResponseOutcome } from "../sim/response";
import type { ResponseClass } from "../sim/response";
import { nextAssistActions, type AssistAction, type AssistContact } from "../sim/assist";
import {
  SessionController, initialSelectedThreatId, type SessionControllerOptions,
} from "./session";

function threat(id: string): PublicThreat {
  return {
    id, spawn_time: 1, speed_class: "medium", visibility_class: "clear",
    flight_pattern: "straight-transit",
    behavior: "steady-transit", cue_clear: true,
    swarm_id: null, swarm_index: null,
  };
}

function scenario(): { threats: PublicThreat[] } {
  return { threats: [threat("T01"), threat("T02")] };
}

/** Public conditions for the workflow fixtures; availability is not asserted. */
const CONDITIONS = { seed: 7, sensor_quality: 0.9, visibility: "clear" } as const;

interface ScheduledRun {
  run: () => void;
  delayMs: number;
  cancelled: boolean;
}

function setup(overrides: {
  response?: SessionControllerOptions["response"];
  autoRequest?: boolean;
  assisted?: boolean;
} = {}) {
  const emitted: EventCreateRequest[] = [];
  const scheduled: ScheduledRun[] = [];
  let clock = 0;
  const controller = new SessionController(scenario(), "SES-1", "TRAIN-001", {
    emit: (e) => emitted.push(e),
    now: () => clock,
    response: overrides.response ?? {
      config: responseConfigFor(CONDITIONS),
      resolve: (id) => resolveResponseOutcome(CONDITIONS, id),
      tracked: () => true,
    },
    // Off by default so timer-sensitive tests stay deterministic; the
    // automation suite opts in explicitly.
    autoRequest: overrides.autoRequest ?? false,
    assisted: overrides.assisted ?? false,
    schedule: (run, delayMs) => {
      scheduled.push({ run, delayMs, cancelled: false });
      return scheduled.length - 1;
    },
    unschedule: (handle) => {
      scheduled[handle as number].cancelled = true;
    },
  });
  return { controller, emitted, scheduled, setClock: (v: number) => { clock = v; } };
}

/** Drives one contact to the classified stage the workflow gates on. */
function classified(
  controller: SessionController,
  id = "T01",
  label: ClassificationLabel = "hostile",
): void {
  controller.spawnThreat(id);
  controller.detect(id);
  expect(controller.classify(id, label)).toBe(true);
}

describe("initialSelectedThreatId", () => {
  it("starts the ground station unlocked", () => {
    expect(initialSelectedThreatId("station", ["T01", "T02"])).toBeNull();
  });

  it("preserves airborne first-contact selection", () => {
    expect(initialSelectedThreatId("airborne", ["T01", "T02"])).toBe("T01");
  });

  it("handles an empty scenario in either mode", () => {
    expect(initialSelectedThreatId("station", [])).toBeNull();
    expect(initialSelectedThreatId("airborne", [])).toBeNull();
  });
});

describe("SessionController", () => {
  it("records sensor provenance on detection without affecting the stage machine", () => {
    const { controller, emitted } = setup();
    controller.start();
    controller.spawnThreat("T01");
    expect(controller.detect("T01", { observer: "scout", sensor: "radar" })).toBe(true);
    const detection = emitted.find((e) => e.type === "THREAT_DETECTED");
    expect(detection?.payload).toEqual({ observer: "scout", sensor: "radar" });
  });

  it("emits SESSION_STARTED and SCENARIO_LOADED on start", () => {
    const { controller, emitted } = setup();
    controller.start();
    expect(emitted.map((e) => e.type)).toEqual(["SESSION_STARTED", "SCENARIO_LOADED"]);
  });

  it("enforces first-attempt-wins per threat", () => {
    const { controller, emitted, setClock } = setup();
    controller.start();
    controller.spawnThreat("T01");
    setClock(1000);
    expect(controller.detect("T01")).toBe(true);
    expect(controller.detect("T01")).toBe(false); // second detect ignored
    expect(controller.classify("T01", "hostile")).toBe(true);
    expect(controller.classify("T01", "friendly")).toBe(false); // second classify ignored
    expect(controller.respond("T01", "hold")).toBe(true);
    expect(controller.respond("T01", "monitor")).toBe(false);
    const types = emitted.map((e) => e.type);
    expect(types.filter((t) => t === "THREAT_DETECTED")).toHaveLength(1);
    expect(types.filter((t) => t === "CLASSIFICATION_SUBMITTED")).toHaveLength(1);
    expect(types.filter((t) => t === "RESPONSE_SUBMITTED")).toHaveLength(1);
  });

  it("rejects classify before detect and respond before classify", () => {
    const { controller } = setup();
    controller.spawnThreat("T01");
    expect(controller.classify("T01", "hostile")).toBe(false);
    expect(controller.detect("T01")).toBe(true);
    expect(controller.respond("T01", "hold")).toBe(false);
  });

  it("uses the injected clock for event timestamps", () => {
    const { controller, emitted, setClock } = setup();
    setClock(2500);
    controller.spawnThreat("T01");
    controller.detect("T01");
    expect(emitted.find((e) => e.type === "THREAT_DETECTED")?.timestamp_ms).toBe(2500);
  });

  it("completes once and emits SESSION_COMPLETED", () => {
    const { controller, emitted } = setup();
    controller.start();
    controller.complete();
    controller.complete();
    expect(controller.status).toBe("completing");
    expect(emitted.filter((e) => e.type === "SESSION_COMPLETED")).toHaveLength(1);
  });
});

describe("simulated response workflow", () => {
  const outcomeFor = (id: string) => resolveResponseOutcome(CONDITIONS, id)!;

  function workflowEvents(emitted: EventCreateRequest[]): EventCreateRequest[] {
    return emitted.filter((e) => e.payload?.workflow === "response-simulation");
  }

  it("refuses a request before the contact is classified", () => {
    const { controller, emitted } = setup();
    controller.spawnThreat("T01");
    controller.detect("T01");
    expect(controller.requestResponse("T01", true)).toBe(false);
    expect(workflowEvents(emitted)).toHaveLength(0);
    controller.classify("T01", "hostile");
    expect(controller.requestResponse("T01", true)).toBe(true);
  });

  it("requires the contact to exist", () => {
    const { controller } = setup();
    expect(controller.responseWorkflow("T99")).toBeUndefined();
    expect(controller.requestResponse("T99", true)).toBe(false);
    expect(controller.approveProposal("T99")).toBe(false);
    expect(controller.cancelSimulation("T99")).toBe(false);
  });

  it("reports unavailable scenarios instead of inventing a workflow", () => {
    const { controller, emitted } = setup({
      response: { config: { available: false, reason: "no resolution" }, resolve: () => null },
    });
    classified(controller);
    expect(controller.responseWorkflow("T01")?.state).toBe("unavailable");
    expect(controller.responseWorkflow("T01")?.reason).toBe("no resolution");
    expect(controller.requestResponse("T01", true)).toBe(false);
    expect(workflowEvents(emitted)).toHaveLength(0);
  });

  it("builds the proposal from trainee-visible evidence and records one phase event", () => {
    const { controller, emitted, setClock } = setup();
    setClock(1200);
    classified(controller, "T01", "hostile");
    setClock(1500);
    expect(controller.requestResponse("T01", true)).toBe(true);
    const workflow = controller.responseWorkflow("T01")!;
    expect(workflow.state).toBe("awaiting_approval");
    expect(workflow.proposal?.basis).toContain("you assessed T01 as hostile");
    expect(workflow.proposal?.basis).toContain("a sensor track is held");
    // A second request while a proposal awaits is refused: no duplicate record.
    expect(controller.requestResponse("T01", true)).toBe(false);
    const events = workflowEvents(emitted);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("RESPONSE_SUBMITTED");
    expect(events[0].threat_id).toBeNull();
    expect(events[0].timestamp_ms).toBe(1500);
    expect(events[0].payload).toMatchObject({
      workflow: "response-simulation", phase: "proposal", threat: "T01",
      measure: "simulated controlled mitigation",
    });
  });

  it("records the requested class and refuses an unknown one", () => {
    const { controller, emitted, setClock } = setup();
    classified(controller, "T01", "hostile");
    classified(controller, "T02", "hostile");
    setClock(1000);
    expect(controller.requestResponse("T01", true, "weapon-class")).toBe(true);
    expect(controller.requestResponse("T02", true, "kinetic" as unknown as ResponseClass)).toBe(false);
    const events = workflowEvents(emitted);
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({
      phase: "proposal",
      threat: "T01",
      response_class: "weapon-class",
      measure: "simulated weapon-class authorization",
    });
    expect(controller.responseWorkflow("T01")?.proposal?.basis).toContain("nothing is executed");
    // The refused class left the second workflow untouched: no record, still ready.
    expect(controller.responseWorkflow("T02")?.state).toBe("ready");
  });

  it("approves once, schedules the resolution, and resolves exactly once", () => {
    const { controller, emitted, scheduled, setClock } = setup();
    classified(controller);
    setClock(1000);
    expect(controller.requestResponse("T01", true)).toBe(true);
    setClock(1400);
    expect(controller.approveProposal("T01")).toBe(true);
    expect(controller.approveProposal("T01")).toBe(false); // no double approval
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].delayMs).toBe(RESPONSE_PROCESSING_MS);
    // The processing window is enforced: an early callback resolves nothing.
    setClock(1400 + RESPONSE_PROCESSING_MS - 1);
    scheduled[0].run();
    expect(controller.responseWorkflow("T01")?.state).toBe("in_progress");
    setClock(1400 + RESPONSE_PROCESSING_MS);
    scheduled[0].run();
    const outcome = outcomeFor("T01");
    const workflow = controller.responseWorkflow("T01")!;
    expect(workflow.state).toBe(outcome.result);
    expect(workflow.outcome).toEqual(outcome);
    scheduled[0].run(); // a duplicate or late timer is a no-op
    const phases = workflowEvents(emitted).map((e) => e.payload?.phase);
    expect(phases).toEqual(["proposal", "approved", "completed"]);
    const completed = workflowEvents(emitted)[2];
    expect(completed.payload).toMatchObject({
      threat: "T01", outcome: outcome.result, cause: outcome.cause,
    });
    const stamps = emitted.map((e) => e.timestamp_ms);
    expect([...stamps].sort((a, b) => a - b)).toEqual(stamps);
  });

  it("fails safely when the outcome cannot resolve", () => {
    const { controller, emitted, scheduled, setClock } = setup({
      response: { config: { available: true, reason: null }, resolve: () => null },
    });
    classified(controller);
    setClock(1000);
    // Refused at the door: a workflow that could never resolve is never started.
    expect(controller.requestResponse("T01", true)).toBe(false);
    expect(controller.responseWorkflow("T01")?.state).toBe("ready");
    expect(controller.approveProposal("T01")).toBe(false);
    expect(scheduled).toHaveLength(0);
    expect(workflowEvents(emitted)).toHaveLength(0);
  });

  it("cancels an in-progress simulation without a fabricated result", () => {
    const { controller, emitted, scheduled, setClock } = setup();
    classified(controller);
    setClock(1000);
    controller.requestResponse("T01", true);
    controller.approveProposal("T01");
    setClock(1500);
    expect(controller.cancelSimulation("T01")).toBe(true);
    expect(controller.cancelSimulation("T01")).toBe(false); // already aborted
    expect(scheduled[0].cancelled).toBe(true);
    scheduled[0].run(); // even if the timer fires, aborted never resolves
    const workflow = controller.responseWorkflow("T01")!;
    expect(workflow.state).toBe("aborted");
    expect(workflow.outcome).toBeNull();
    expect(workflowEvents(emitted).map((e) => e.payload?.phase)).toEqual([
      "proposal", "approved", "cancelled",
    ]);
  });

  it("rejects, reopens, and requests again without stale proposal state", () => {
    const { controller, emitted, setClock } = setup();
    classified(controller);
    setClock(1000);
    controller.requestResponse("T01", true);
    expect(controller.rejectProposal("T01")).toBe(true);
    expect(controller.rejectProposal("T01")).toBe(false);
    const before = workflowEvents(emitted).length;
    setClock(1100);
    expect(controller.reopenProposal("T01")).toBe(true);
    expect(workflowEvents(emitted)).toHaveLength(before); // reopen records nothing
    expect(controller.responseWorkflow("T01")?.proposal).toBeNull();
    setClock(1200);
    expect(controller.requestResponse("T01", true)).toBe(true);
    expect(workflowEvents(emitted).map((e) => e.payload?.phase)).toEqual([
      "proposal", "rejected", "proposal",
    ]);
  });

  it("aborts mid-workflow on completion and emits nothing after SESSION_COMPLETED", () => {
    const { controller, emitted, scheduled, setClock } = setup();
    classified(controller);
    setClock(1000);
    controller.requestResponse("T01", true);
    controller.approveProposal("T01");
    setClock(1500);
    controller.complete();
    expect(scheduled[0].cancelled).toBe(true);
    scheduled[0].run();
    expect(controller.responseWorkflow("T01")?.state).toBe("aborted");
    const types = emitted.map((e) => e.type);
    expect(types[types.length - 1]).toBe("SESSION_COMPLETED");
    expect(types.filter((t) => t === "SESSION_COMPLETED")).toHaveLength(1);
    // No cancelled or completed phase ever follows the completion record.
    expect(workflowEvents(emitted).map((e) => e.payload?.phase)).toEqual([
      "proposal", "approved",
    ]);
  });

  it("keeps the scored response path untouched alongside a simulation", () => {
    const { controller, emitted, scheduled, setClock } = setup();
    classified(controller);
    setClock(1000);
    controller.requestResponse("T01", true);
    controller.approveProposal("T01");
    setClock(1000 + RESPONSE_PROCESSING_MS);
    scheduled[0].run();
    expect(controller.respond("T01", "hold")).toBe(true);
    const scored = emitted.find(
      (e) => e.type === "RESPONSE_SUBMITTED" && e.threat_id === "T01",
    );
    expect(scored?.payload).toEqual({ response: "hold", aid: "assisted" });
    expect(controller.responseWorkflow("T01")?.state).toBe(outcomeFor("T01").result);
  });

  it("stamps manual and assisted aid provenance on scored responses", () => {
    const { controller, emitted, setClock } = setup();
    classified(controller, "T01");
    classified(controller, "T02", "friendly");
    setClock(1000);
    controller.requestResponse("T01", true); // the assistant is used for T01 only
    setClock(2000);
    expect(controller.respond("T01", "hold")).toBe(true);
    expect(controller.respond("T02", "monitor")).toBe(true);
    const scored = emitted.filter((e) => e.type === "RESPONSE_SUBMITTED" && e.threat_id !== null);
    expect(scored.find((e) => e.threat_id === "T01")?.payload?.aid).toBe("assisted");
    expect(scored.find((e) => e.threat_id === "T02")?.payload?.aid).toBe("manual");
  });

  it("keeps the assisted mark after a rejected proposal", () => {
    const { controller, emitted, setClock } = setup();
    classified(controller);
    setClock(1000);
    controller.requestResponse("T01", true);
    setClock(1100);
    controller.rejectProposal("T01");
    setClock(1200);
    expect(controller.respond("T01", "hold")).toBe(true);
    const scored = emitted.find((e) => e.type === "RESPONSE_SUBMITTED" && e.threat_id === "T01");
    expect(scored?.payload?.aid).toBe("assisted");
  });
});

describe("idle auto-request automation", () => {
  function workflowEvents(emitted: EventCreateRequest[]): EventCreateRequest[] {
    return emitted.filter((e) => e.payload?.workflow === "response-simulation");
  }

  it("requests a mitigation proposal after the idle window, marked auto", () => {
    const { controller, emitted, scheduled, setClock } = setup({ autoRequest: true });
    classified(controller, "T01", "hostile");
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].delayMs).toBe(AUTO_REQUEST_MS);
    setClock(AUTO_REQUEST_MS);
    scheduled[0].run();
    const workflow = controller.responseWorkflow("T01")!;
    expect(workflow.state).toBe("awaiting_approval");
    expect(workflow.proposal?.responseClass).toBe("mitigation");
    const events = workflowEvents(emitted);
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({
      phase: "proposal", threat: "T01", auto: true, response_class: "mitigation",
    });
    // A proposal only: nothing approves or resolves without an operator click.
    expect(controller.responseWorkflow("T01")?.state).toBe("awaiting_approval");
  });

  it("never fires when the operator has the automation off", () => {
    const { controller, emitted, scheduled } = setup();
    classified(controller);
    expect(scheduled).toHaveLength(0);
    expect(workflowEvents(emitted)).toHaveLength(0);
  });

  it("is superseded by a manual request", () => {
    const { controller, emitted, scheduled, setClock } = setup({ autoRequest: true });
    classified(controller);
    setClock(500);
    controller.requestResponse("T01", true, "weapon-class");
    expect(scheduled[0].cancelled).toBe(true);
    setClock(2000);
    scheduled[0].run(); // a cancelled handle cannot overwrite the manual request
    expect(controller.responseWorkflow("T01")?.proposal?.responseClass).toBe("weapon-class");
    expect(workflowEvents(emitted)).toHaveLength(1);
  });

  it("skips contacts that were already responded to", () => {
    const { controller, emitted, scheduled, setClock } = setup({ autoRequest: true });
    classified(controller);
    setClock(100);
    expect(controller.respond("T01", "hold")).toBe(true);
    expect(scheduled[0].cancelled).toBe(true);
    scheduled[0].run();
    expect(workflowEvents(emitted)).toHaveLength(0);
  });

  it("cancels a pending auto-request when the session completes", () => {
    const { controller, emitted, scheduled, setClock } = setup({ autoRequest: true });
    classified(controller);
    setClock(2000);
    controller.complete();
    expect(scheduled[0].cancelled).toBe(true);
    scheduled[0].run();
    expect(workflowEvents(emitted)).toHaveLength(0);
    const types = emitted.map((e) => e.type);
    expect(types[types.length - 1]).toBe("SESSION_COMPLETED");
  });

  it("stops pending auto-requests when switched off at runtime", () => {
    const { controller, emitted, scheduled, setClock } = setup({ autoRequest: true });
    classified(controller);
    controller.setAutoRequestEnabled(false);
    expect(scheduled[0].cancelled).toBe(true);
    setClock(5000);
    scheduled[0].run();
    expect(workflowEvents(emitted)).toHaveLength(0);
  });

  it("uses the tracked provider for the auto proposal basis", () => {
    const { controller, scheduled, setClock } = setup({
      autoRequest: true,
      response: {
        config: responseConfigFor(CONDITIONS),
        resolve: (id) => resolveResponseOutcome(CONDITIONS, id),
        tracked: () => false,
      },
    });
    classified(controller);
    setClock(AUTO_REQUEST_MS);
    scheduled[0].run();
    expect(controller.responseWorkflow("T01")?.proposal?.basis)
      .toContain("no track is currently held");
  });
});

describe("AI-assisted provenance", () => {
  it("exposes the assisted flag", () => {
    expect(setup({ assisted: true }).controller.assisted).toBe(true);
    expect(setup().controller.assisted).toBe(false);
  });

  it("stamps assist provenance on detection and classification", () => {
    const { controller, emitted } = setup({ assisted: true });
    controller.start();
    controller.spawnThreat("T01");
    controller.detect("T01", { observer: "station", sensor: "visual" });
    controller.classify("T01", "suspicious", { observer: "station", sensor: "visual" });
    const detection = emitted.find((e) => e.type === "THREAT_DETECTED");
    const classification = emitted.find((e) => e.type === "CLASSIFICATION_SUBMITTED");
    expect(detection?.payload).toMatchObject({
      observer: "station", sensor: "visual", aid: "assisted", by: "assistant",
    });
    expect(classification?.payload).toMatchObject({
      label: "suspicious", aid: "assisted", by: "assistant",
    });
  });

  it("stamps assist provenance on the scored response without workflow history", () => {
    const { controller, emitted } = setup({ assisted: true });
    controller.start();
    controller.spawnThreat("T01");
    controller.detect("T01");
    controller.classify("T01", "hostile");
    expect(controller.respond("T01", "hold")).toBe(true);
    const response = emitted.find((e) => e.type === "RESPONSE_SUBMITTED");
    expect(response?.payload).toMatchObject({
      response: "hold", aid: "assisted", by: "assistant",
    });
  });

  it("leaves manual payloads exactly as they were", () => {
    const { controller, emitted } = setup();
    controller.start();
    controller.spawnThreat("T01");
    controller.detect("T01", { observer: "station", sensor: "visual" });
    controller.classify("T01", "hostile");
    controller.respond("T01", "hold");
    const detection = emitted.find((e) => e.type === "THREAT_DETECTED");
    const classification = emitted.find((e) => e.type === "CLASSIFICATION_SUBMITTED");
    const response = emitted.find((e) => e.type === "RESPONSE_SUBMITTED");
    expect(detection?.payload).toEqual({ observer: "station", sensor: "visual" });
    expect(classification?.payload).toEqual({ label: "hostile" });
    expect(response?.payload?.aid).toBe("manual");
    expect(response?.payload?.by).toBeUndefined();
  });

  it("attributes an operator override inside an assisted session to the operator", () => {
    const { controller, emitted } = setup({ assisted: true });
    controller.start();
    controller.spawnThreat("T01");
    controller.detect("T01", { by: "operator" });
    controller.classify("T01", "hostile", { by: "operator" });
    controller.respond("T01", "hold", { by: "operator" });
    const detection = emitted.find((e) => e.type === "THREAT_DETECTED");
    const classification = emitted.find((e) => e.type === "CLASSIFICATION_SUBMITTED");
    const response = emitted.find((e) => e.type === "RESPONSE_SUBMITTED");
    for (const event of [detection, classification, response]) {
      expect(event?.payload).toMatchObject({ aid: "assisted", by: "operator" });
    }
  });

  it("records the assisted driver's automatic approval as such", () => {
    const { controller, emitted, setClock } = setup({ assisted: true });
    classified(controller);
    setClock(1000);
    expect(controller.requestResponse("T01", true, "mitigation")).toBe(true);
    setClock(1100);
    expect(controller.approveProposal("T01", { auto: true })).toBe(true);
    const phases = emitted.filter((e) => e.payload?.workflow !== undefined);
    const approved = phases.find((e) => e.payload?.phase === "approved");
    expect(approved?.payload?.auto).toBe(true);
  });

  it("keeps approval gates untouched: an unrequested contact cannot be approved", () => {
    const { controller } = setup({ assisted: true });
    classified(controller);
    expect(controller.approveProposal("T01", { auto: true })).toBe(false);
  });
});

describe("assisted driver flow through the real gates", () => {
  /**
   * The shape of main.ts's applyAssistAction, reduced to one contact and the
   * real controller methods. It proves the sequence the assistant drives is
   * gated exactly like a trainee's, from first detection to resolved measure.
   */
  function driveLoop(
    controller: SessionController,
    clock: { ms: number; set: (v: number) => void },
  ): string[] {
    const seen: string[] = [];
    const contacts = (): AssistContact[] => {
      const entry = controller.threats[0];
      const workflow = entry.stage === "responded"
        ? controller.responseWorkflow(entry.profile.id)?.state ?? "none"
        : "none";
      return [{
        id: entry.profile.id,
        stage: entry.stage,
        tracked: true,
        visual: true,
        workflow,
      }];
    };
    const apply = (action: AssistAction): void => {
      switch (action.kind) {
        case "detect": controller.detect(action.id); break;
        case "classify": controller.classify(action.id, "hostile"); break;
        case "respond": controller.respond(action.id, "hold"); break;
        case "request":
          controller.requestResponse(action.id, true, "weapon-class", { auto: true });
          break;
        case "approve": controller.approveProposal(action.id, { auto: true }); break;
      }
    };
    for (let pass = 0; pass < 12; pass += 1) {
      const actions = nextAssistActions(contacts(), new Set());
      if (actions.length === 0) break;
      for (const action of actions) {
        seen.push(action.kind);
        apply(action);
      }
      clock.ms += 1000;
      clock.set(clock.ms);
    }
    return seen;
  }

  it("runs detect, classify, respond, request and approve in order", () => {
    const { controller, emitted, scheduled, setClock } = setup({ assisted: true });
    const clock = { ms: 0, set: setClock };
    controller.start();
    controller.spawnThreat("T01");

    const seen = driveLoop(controller, clock);

    expect(seen).toEqual(["detect", "classify", "respond", "request", "approve"]);
    // Every scored decision is stamped assisted; the workflow records the
    // automatic request and approval.
    const decisions = emitted.filter((e) =>
      e.type === "THREAT_DETECTED" || e.type === "CLASSIFICATION_SUBMITTED"
      || e.type === "RESPONSE_SUBMITTED" && e.payload?.workflow === undefined);
    expect(decisions.every((e) => e.payload?.aid === "assisted")).toBe(true);
    const proposal = emitted.find((e) => e.payload?.phase === "proposal");
    expect(proposal?.payload?.auto).toBe(true);

    // Approval scheduled the resolution; run it once the processing time has
    // passed and the contact must read resolved with no further action.
    const timer = scheduled.find((run) => !run.cancelled && run.delayMs === RESPONSE_PROCESSING_MS);
    expect(timer).toBeDefined();
    clock.ms += RESPONSE_PROCESSING_MS + 1000;
    setClock(clock.ms);
    timer!.run();

    expect(emitted.some((e) => e.type === "THREAT_RESOLVED")).toBe(true);
    expect(controller.responseWorkflow("T01")?.outcome).not.toBeNull();
  });
});
