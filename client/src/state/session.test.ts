import { describe, expect, it } from "vitest";
import type { EventCreateRequest, PublicThreat } from "../api/types";
import { SessionController, initialSelectedThreatId } from "./session";

function threat(id: string): PublicThreat {
  return {
    id, spawn_time: 1, speed_class: "medium", visibility_class: "clear",
    behavior: "steady-transit", cue_clear: true,
  };
}

function scenario(): { threats: PublicThreat[] } {
  return { threats: [threat("T01"), threat("T02")] };
}

function setup() {
  const emitted: EventCreateRequest[] = [];
  let clock = 0;
  const controller = new SessionController(scenario(), "SES-1", "TRAIN-001", {
    emit: (e) => emitted.push(e),
    now: () => clock,
  });
  return { controller, emitted, setClock: (v: number) => { clock = v; } };
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
