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

  it("marks the selected blip with a halo and nothing else", () => {
    const html = buildRadarHtml([track({ id: "T01" }), track({ id: "T02" })], 400, 0, "T02");
    expect(html).toMatch(/radar-blip is-fresh is-selected" data-track="T02"/);
    expect(html).toContain("radar-halo");
    expect(html).not.toMatch(/is-selected" data-track="T01"/);
  });

  it("renders a sweep wedge slaved to the sweep hand", () => {
    const first = buildRadarHtml([], 400, 0);
    const second = buildRadarHtml([], 400, 1);
    expect(first).toContain("radar-sweep-wedge");
    expect(first).toContain("radar-ping");
    // The wedge rotates with the same tick clock as the hand.
    const dOf = (html: string): string => {
      const m = html.match(/<path d="([^"]+)" class="radar-sweep-wedge"/);
      return m ? m[1] : "";
    };
    expect(dOf(first)).not.toBe("");
    expect(dOf(second)).not.toBe("");
    expect(dOf(first)).not.toBe(dOf(second));
  });

  it("renders cardinal marks and bearing ticks without leaking truth", () => {
    const html = buildRadarHtml([track({ id: "T01" })], 400, 0).toLowerCase();
    for (const mark of [">n<", ">e<", ">s<", ">w<"]) expect(html).toContain(mark);
    expect(html).toContain("radar-tick");
    for (const leaked of ["classification_label", "expected_response", "suspicious", "civilian"]) {
      expect(html).not.toContain(leaked);
    }
  });

  it("reads out the selected track's bearing, range, source, and freshness", () => {
    const html = buildRadarHtml(
      [track({ id: "T02", bearingDeg: 45, range: 212, lastSource: "radar", lastTick: 3 })],
      400, 3, "T02",
    );
    expect(html).toContain("radar-readout");
    expect(html).toContain("T02");
    expect(html).toContain("045°");
    expect(html).toContain("212u");
    expect(html).toContain("fresh");
    expect(html).not.toContain("no selection");
  });

  it("shows a quiet placeholder with no selection and coasting state otherwise", () => {
    expect(buildRadarHtml([track({ id: "T01" })], 400, 0)).toContain("no selection");
    const html = buildRadarHtml(
      [track({ id: "T01", lastSource: "visual", seenVisual: true, lastTick: 1 })],
      400, 4, "T01",
    );
    expect(html).toContain("visual hold");
    expect(html).toContain("coasting");
  });

  it("appends live altitude to the readout when supplied", () => {
    const html = buildRadarHtml(
      [track({ id: "T01", bearingDeg: 90, range: 200, lastTick: 2 })],
      400, 2, "T01", [], { T01: 132 },
    );
    expect(html).toContain("ALT 132u");
    const bare = buildRadarHtml(
      [track({ id: "T01", bearingDeg: 90, range: 200, lastTick: 2 })],
      400, 2, "T01",
    );
    expect(bare).not.toContain("ALT");
  });

  it("flashes only tracks first seen on the latest sweep", () => {
    const html = buildRadarHtml(
      [track({ id: "T01" }), track({ id: "T02" })],
      400, 5, null, ["T02"],
    );
    expect(html).toContain("radar-new-ring");
    expect(html).toMatch(/is-new" data-track="T02"/);
    expect(html).not.toMatch(/is-new" data-track="T01"/);
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
