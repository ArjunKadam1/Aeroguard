import { describe, expect, it } from "vitest";
import { buildRadarHtml } from "./radar";
import { buildSensorStatusHtml } from "./sensors";
import type { Track } from "../sim/observation";

function track(partial: Partial<Track> & { id: string }): Track {
  return {
    lastSource: "radar", seenVisual: false, hits: 1, lastTick: 0,
    bearingDeg: 90, range: 200, ...partial,
  };
}

describe("buildRadarHtml", () => {
  it("plots fresh blips with ids at bearing positions", () => {
    const html = buildRadarHtml([track({ id: "T01" })], 400, 0);
    expect(html).toContain('data-track="T01"');
    expect(html).toContain("T01");
    expect(html).toContain("is-fresh");
  });

  it("dims coasting tracks so trust is visible", () => {
    // lastTick 0 against tick 1: coasting, hence stale.
    const html = buildRadarHtml([track({ id: "T01" })], 400, 1);
    expect(html).toContain("is-stale");
    expect(html).not.toContain("is-fresh");
  });

  it("places a due-north blip at the top of the scope", () => {
    const html = buildRadarHtml([track({ id: "T01", bearingDeg: 0, range: 200 })], 400, 0);
    // Range 200 of 400 => half radius => y = 100 - 44 = 56.
    expect(html).toContain('cy="56.0"');
  });

  it("shows range rings with labels", () => {
    const html = buildRadarHtml([], 400, 0);
    expect(html).toContain("radar-ring");
    expect(html).toContain("SCOPE CLEAR");
    expect(html).toContain("RADAR · 400u");
  });

  it("rotates the sweep hand with the tick", () => {
    const first = buildRadarHtml([], 400, 0);
    const second = buildRadarHtml([], 400, 1);
    expect(first).toContain("rotate(0 100 100)");
    expect(second).toContain("rotate(45 100 100)");
  });

  it("never renders identity or classification detail", () => {
    const html = buildRadarHtml([track({ id: "T01" })], 400, 0);
    expect(html).not.toContain("classification");
    expect(html).not.toContain("hostile");
    expect(html).not.toContain("behavior");
  });

  it("renders visual-held contacts as hollow rings, not radar blips", () => {
    const html = buildRadarHtml([track({ id: "T01", lastSource: "visual", seenVisual: true })], 400, 0);
    expect(html).toContain("is-visual");
    expect(html).not.toContain("is-fresh");
    expect(html).toContain("visual hold");
  });

  it("shows both sources side by side with a source legend", () => {
    const html = buildRadarHtml([
      track({ id: "T01", lastSource: "radar" }),
      track({ id: "T02", lastSource: "visual", seenVisual: true }),
    ], 400, 0);
    expect(html).toContain('data-track="T01"');
    expect(html).toContain('data-track="T02"');
    expect(html).toContain("is-fresh");
    expect(html).toContain("is-visual");
    expect(html).toContain("visual hold");
  });

  it("exposes blips as keyboard-operable buttons with spoken labels", () => {
    const html = buildRadarHtml([track({ id: "T01" })], 400, 0);
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('role="button"');
    expect(html).toContain('aria-label="Select contact T01 · radar"');
  });
});

describe("buildSensorStatusHtml", () => {
  it("states scout visual and radar capability", () => {
    const html = buildSensorStatusHtml(
      "scout",
      { visualRange: 150, radarRange: 400, radarPeriod: 2 },
      { sensorQuality: 1, night: false, visibility: "clear" },
    );
    expect(html).toContain("150u");
    expect(html).toContain("400u");
    expect(html).toContain("sensors nominal");
  });

  it("states the station has no radar", () => {
    const html = buildSensorStatusHtml(
      "station",
      { visualRange: 1200, radarRange: 0, radarPeriod: 2 },
      { sensorQuality: 1, night: false, visibility: "clear" },
    );
    expect(html).toContain("not fitted");
  });

  it("explains degradation reasons instead of hiding them", () => {
    const html = buildSensorStatusHtml(
      "scout",
      { visualRange: 150, radarRange: 400, radarPeriod: 2 },
      { sensorQuality: 0.4, night: true, visibility: "poor" },
    );
    expect(html).toContain("night");
    expect(html).toContain("poor visibility");
    expect(html).toContain("0.40");
  });
});
