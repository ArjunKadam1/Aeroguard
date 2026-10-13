import { describe, expect, it } from "vitest";
import { createEventQueue, type EventSubmitter } from "./eventQueue";
import type { EventCreateRequest } from "../api/types";

function event(type: EventCreateRequest["type"]): EventCreateRequest {
  return { type, timestamp_ms: 0, threat_id: null, payload: {} };
}

describe("createEventQueue", () => {
  it("submits events in order and flush waits for all of them", async () => {
    const submitted: string[] = [];
    const submit: EventSubmitter = async (next) => {
      submitted.push(next.type);
    };
    const queue = createEventQueue(submit, () => {
      throw new Error("no error expected");
    });

    queue.emit(event("SESSION_STARTED"));
    queue.emit(event("SCENARIO_LOADED"));
    queue.emit(event("SESSION_COMPLETED"));
    await queue.flush();

    expect(submitted).toEqual(["SESSION_STARTED", "SCENARIO_LOADED", "SESSION_COMPLETED"]);
  });

  it("reports a failure without breaking later events", async () => {
    const submitted: string[] = [];
    const errors: unknown[] = [];
    const submit: EventSubmitter = async (next) => {
      submitted.push(next.type);
      if (next.type === "THREAT_DETECTED") throw new Error("network down");
    };
    const queue = createEventQueue(submit, (error) => {
      errors.push(error);
    });

    queue.emit(event("THREAT_DETECTED"));
    queue.emit(event("SESSION_COMPLETED"));
    await queue.flush();

    expect(submitted).toEqual(["THREAT_DETECTED", "SESSION_COMPLETED"]);
    expect(errors).toHaveLength(1);
  });
});
