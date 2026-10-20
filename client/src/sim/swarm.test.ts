import { describe, expect, it } from "vitest";
import type { PublicThreat } from "../api/types";
import { buildSwarmIndex } from "./swarm";

function threat(
  id: string,
  swarmId: string | null,
  swarmIndex: number | null,
): PublicThreat {
  return {
    id,
    spawn_time: 5,
    speed_class: "medium",
    visibility_class: "clear",
    flight_pattern: "wide-weave",
    behavior: "erratic",
    cue_clear: true,
    swarm_id: swarmId,
    swarm_index: swarmIndex,
  };
}

describe("buildSwarmIndex", () => {
  it("indexes every member against the same lead and count", () => {
    const index = buildSwarmIndex([
      threat("T01", "S01", 0),
      threat("T02", "S01", 1),
      threat("T03", "S01", 2),
    ]);
    for (const id of ["T01", "T02", "T03"]) {
      const member = index.get(id)!;
      expect(member.lead.id).toBe("T01");
      expect(member.count).toBe(3);
    }
    expect(index.get("T02")!.index).toBe(1);
    expect(index.get("T03")!.index).toBe(2);
  });

  it("orders members by swarm_index, never by array order", () => {
    const index = buildSwarmIndex([
      threat("T03", "S01", 2),
      threat("T01", "S01", 0),
      threat("T02", "S01", 1),
    ]);
    expect(index.get("T03")!.lead.id).toBe("T01");
    expect(index.get("T02")!.index).toBe(1);
  });

  it("ignores independent contacts and malformed one-member groups", () => {
    const index = buildSwarmIndex([
      threat("T01", null, null),
      threat("T02", "S01", 0),
      threat("T03", "S02", 0),
    ]);
    expect(index.size).toBe(0);
  });

  it("keeps separate groups separate", () => {
    const index = buildSwarmIndex([
      threat("T01", "S01", 0),
      threat("T02", "S01", 1),
      threat("T03", "S02", 0),
      threat("T04", "S02", 1),
      threat("T05", "S02", 2),
    ]);
    expect(index.get("T02")!.lead.id).toBe("T01");
    expect(index.get("T02")!.count).toBe(2);
    expect(index.get("T05")!.lead.id).toBe("T03");
    expect(index.get("T05")!.count).toBe(3);
  });

  it("is deterministic and empty for an empty scenario", () => {
    expect(buildSwarmIndex([]).size).toBe(0);
    const threats = [threat("T01", "S01", 1), threat("T02", "S01", 0)];
    expect([...buildSwarmIndex(threats).entries()])
      .toEqual([...buildSwarmIndex(threats).entries()]);
  });
});
