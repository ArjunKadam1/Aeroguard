import { describe, expect, it, vi } from "vitest";
import { createApiClient } from "./client";
import type { Scenario, SessionCreated } from "./types";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("createApiClient", () => {
  it("POSTs a scenario request to /api/v1/scenarios/generate and returns the body", async () => {
    const scenario = { scenario_id: "SCN-000001" } as Scenario;
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(scenario));
    const api = createApiClient("/api/v1", fetchFn as unknown as typeof fetch);

    const result = await api.generateScenario({
      difficulty: 3, environment: "urban", time_of_day: "day", threat_count: 1,
    });

    expect(result).toEqual(scenario);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe("/api/v1/scenarios/generate");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toMatchObject({ difficulty: 3, environment: "urban" });
  });

  it("creates a session and submits an event", async () => {
    const session = { session_id: "SES-1", status: "active" } as SessionCreated;
    const created = { event_id: "EVT-001", accepted: true };
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(session))
      .mockResolvedValueOnce(jsonResponse(created));
    const api = createApiClient("/api/v1", fetchFn as unknown as typeof fetch);

    await api.createSession({ trainee_id: "TRAIN-001", scenario_id: "SCN-000001" });
    const emitted = await api.submitEvent("SES-1", {
      type: "THREAT_DETECTED", timestamp_ms: 1000, threat_id: "T01",
    });

    expect(emitted).toEqual(created);
    expect(fetchFn.mock.calls[1][0]).toBe("/api/v1/sessions/SES-1/events");
  });

  it("throws with status and detail on a non-2xx response", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({ detail: "unknown session_id: SES-X" }, 404),
    );
    const api = createApiClient("/api/v1", fetchFn as unknown as typeof fetch);
    await expect(api.completeSession("SES-X")).rejects.toThrow(/404.*unknown session_id/);
  });

  it("lists and releases scripted scenarios", async () => {
    const catalog = [{ key: "first-contact-day", title: "First Contact" }];
    const released = { scenario_id: "SCRIPT-FIRST-CONTACT" };
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(catalog))
      .mockResolvedValueOnce(jsonResponse(released));
    const api = createApiClient("/api/v1", fetchFn as unknown as typeof fetch);

    expect(await api.listScriptedScenarios()).toEqual(catalog);
    expect(fetchFn.mock.calls[0][0]).toBe("/api/v1/scenarios/scripted");

    expect(await api.createScriptedScenario("first-contact-day")).toEqual(released);
    const [url, init] = fetchFn.mock.calls[1];
    expect(url).toBe("/api/v1/scenarios/scripted");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ scenario_key: "first-contact-day" });
  });

  it("fetches the redacted scenario view without ground-truth fields", async () => {
    const view = {
      scenario_id: "SCN-000001", observation_version: "1.0",
      threats: [{ id: "T01", behavior: "orbiting", cue_clear: true }],
      cue_legend: { orbiting: "circling — often suspicious" },
    };
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(view));
    const api = createApiClient("/api/v1", fetchFn as unknown as typeof fetch);

    const result = await api.fetchScenarioView("SCN-000001");

    expect(result).toEqual(view);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe("/api/v1/scenarios/SCN-000001/view");
    expect(init.method).toBe("GET");
  });
});

