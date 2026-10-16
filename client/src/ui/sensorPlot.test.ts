import { describe, expect, it } from "vitest";
import type { Track } from "../sim/observation";
import { STATION_HALF_FOV, STATION_VISUAL_RANGE } from "../sim/observation";
import { buildSensorPlotHtml, lookBearingDeg } from "./sensorPlot";

function track(over: Partial<Track> = {}): Track {
  return {
    id: "T01",
    lastSource: "visual",
    seenVisual: true,
    hits: 1,
    lastTick: 10,
    bearingDeg: 45,
    range: 600,
    ...over,
  };
}

describe("sector plot geometry", () => {
  it("derives the wedge bearing from the station observer", () => {
    // Heading 0 aims near-north (the mast aim is slightly west of the mast).
    const look = lookBearingDeg(0);
    expect(look).toBeGreaterThan(340);
    expect(look).toBeLessThan(360);
  });

  it("swings the wedge with the mast heading", () => {
    const base = lookBearingDeg(0);
    const turned = lookBearingDeg(0.5);
    // 0.5 rad ≈ 28.6° clockwise.
    expect(((turned - base) % 360 + 360) % 360).toBeCloseTo(28.65, 0);
  });

  it("draws range rings labelled in world units", () => {
    const html = buildSensorPlotHtml([], 10, 0, null);
    expect(html).toContain(Math.round(STATION_VISUAL_RANGE / 3).toString());
    expect(html).toContain(STATION_VISUAL_RANGE.toString());
    expect(html).toContain(`±${Math.round((STATION_HALF_FOV * 180) / Math.PI)}°`);
    expect(html).toContain("no radar");
    expect(html).toContain(">N<");
  });

  it("invites a sweep when the sector is empty", () => {
    const html = buildSensorPlotHtml([], 10, 0, null);
    expect(html).toContain("NO CONTACTS IN SECTOR");
    expect(html).toContain("hold S to sweep");
  });
});

describe("sector plot blips", () => {
  it("styles blips by track certainty and marks the selection", () => {
    const tracks = [
      track({ id: "T01", lastTick: 10, seenVisual: true }),
      track({ id: "T02", lastTick: 10, seenVisual: false, hits: 1, lastSource: "radar" }),
      track({ id: "T03", lastTick: 8, seenVisual: true }),
    ];
    const html = buildSensorPlotHtml(tracks, 10, 0, "T01");
    expect(html).toContain("plot-confirmed");
    expect(html).toContain("plot-tentative");
    expect(html).toContain("plot-coasting");
    expect(html).toContain("is-selected");
    expect(html).toContain("plot-halo");
    for (const id of ["T01", "T02", "T03"]) {
      expect(html).toContain(`data-track="${id}"`);
    }
  });

  it("renders cardinal directions and bearing ticks", () => {
    const html = buildSensorPlotHtml([], 10, 0, null);
    for (const mark of [">N<", ">E<", ">S<", ">W<"]) expect(html).toContain(mark);
    expect(html).toContain("plot-tick");
  });

  it("exposes blips as keyboard-operable buttons with spoken labels", () => {
    const html = buildSensorPlotHtml([track({ id: "T01" })], 10, 0, null);
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('role="button"');
    expect(html).toContain('aria-label="Select contact T01, confirmed"');
  });
});

describe("sector plot information leakage", () => {
  it("renders track ids and states but no hidden answers", () => {
    // Tracks carry no classification truth by construction; the plot must
    // render only what it is given, with no label/response vocabulary.
    const html = buildSensorPlotHtml([track({ id: "T01" })], 10, 0, null).toLowerCase();
    expect(html).toContain("t01");
    for (const leaked of ["hostile", "friendly", "suspicious", "hold", "monitor", "report", "intercept"]) {
      expect(html).not.toContain(leaked);
    }
  });

  it("shows nothing for contacts outside the track picture", () => {
    const html = buildSensorPlotHtml([], 10, 0, null);
    expect(html).not.toContain("data-track=");
    expect(html).not.toContain("T02");
  });
});
