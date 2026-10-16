import { describe, expect, it } from "vitest";
import type { Scenario, ThreatProfile } from "../api/types";
import { Spawner } from "./spawner";

function threat(id: string, spawn_time: number): ThreatProfile {
  return {
    id, category: "unknown_aerial_object", classification_label: "unknown",
    expected_response: "track", spawn_time, speed_class: "medium", visibility_class: "clear",
    flight_pattern: "straight-transit",
  };
}
function scenario(): Scenario {
  return {
    scenario_id: "SCN-000001", seed: 1, generator_version: "1.0", difficulty: 3,
    environment: "urban", time_of_day: "day", visibility: "clear", sensor_quality: 1,
    duration_seconds: 120, threats: [threat("T01", 1), threat("T02", 3)],
  };
}

describe("Spawner", () => {
  it("spawns each threat exactly once at or after its spawn_time", () => {
    const spawned: string[] = [];
    const spawner = new Spawner(scenario(), (id) => spawned.push(id));
    spawner.update(0);
    expect(spawned).toEqual([]);
    spawner.update(1);
    expect(spawned).toEqual(["T01"]);
    spawner.update(2.9);
    expect(spawned).toEqual(["T01"]);
    spawner.update(3.0);
    spawner.update(4.0);
    expect(spawned).toEqual(["T01", "T02"]);
  });
});
