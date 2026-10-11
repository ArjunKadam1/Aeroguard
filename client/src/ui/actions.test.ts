import { describe, expect, it } from "vitest";
import { ACTION_GROUPS, enabledGroupFor, isGroupEnabled } from "./actions";
import type { HudStage } from "./hud";

const STAGES: HudStage[] = ["pending", "spawned", "detected", "classified", "responded"];

describe("enabledGroupFor", () => {
  it("gates each stage to exactly the decision the session allows", () => {
    expect(enabledGroupFor("pending")).toBeNull();
    expect(enabledGroupFor("spawned")).toBe("detect");
    expect(enabledGroupFor("detected")).toBe("classify");
    expect(enabledGroupFor("classified")).toBe("respond");
    expect(enabledGroupFor("responded")).toBeNull();
  });

  it("never enables more than one group at a time", () => {
    for (const stage of STAGES) {
      const enabled = ACTION_GROUPS.filter((group) => isGroupEnabled(stage, group));
      expect(enabled.length).toBeLessThanOrEqual(1);
    }
  });

  it("matches the order enforced by the session state machine", () => {
    // detect -> classify -> respond, strictly forward.
    const order: HudStage[] = ["spawned", "detected", "classified"];
    const groups = order.map(enabledGroupFor);
    expect(groups).toEqual(["detect", "classify", "respond"]);
  });

  it("disables every group once the threat is resolved or not yet spawned", () => {
    for (const stage of ["pending", "responded"] as HudStage[]) {
      expect(ACTION_GROUPS.some((group) => isGroupEnabled(stage, group))).toBe(false);
    }
  });
});