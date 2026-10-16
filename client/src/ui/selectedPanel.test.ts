import { describe, expect, it } from "vitest";
import { buildSelectedPanelHtml } from "./selectedPanel";

describe("buildSelectedPanelHtml", () => {
  it("shows an empty state when nothing is selected", () => {
    const html = buildSelectedPanelHtml(null);
    expect(html).toContain("No contact selected");
  });

  it("renders the selected contact's evidence and next step", () => {
    const html = buildSelectedPanelHtml({
      state: { id: "T01", stage: "spawned", behavior: "orbiting", track: "confirmed" },
      behaviorHint: "circling a point of interest — often suspicious",
      observer: "station",
      sensor: "visual",
      tracked: true,
      firstSeenMs: 2300,
      pos: { x: 123.4, z: -456.7, alt: 78.2 },
      speedClass: "fast",
      flightPattern: "wide-weave",
    });
    expect(html).toContain("T01");
    expect(html).toContain("spawned");
    expect(html).toContain("orbiting");
    expect(html).toContain("station · visual");
    expect(html).toContain("first seen 2.3s");
    expect(html).toContain("DETECT");
    expect(html).toContain("X +123 · Z -457 · ALT 78u");
    expect(html).toContain("fast");
    expect(html).toContain("wide-weave");
  });

  it("reports a lost track instead of a stale state", () => {
    const html = buildSelectedPanelHtml({
      state: { id: "T02", stage: "detected", behavior: "erratic", track: "coasting" },
      behaviorHint: "unpredictable maneuvers — identity unclear",
      observer: "airborne",
      sensor: "radar",
      tracked: false,
      firstSeenMs: null,
      pos: null,
      speedClass: null,
      flightPattern: null,
    });
    expect(html).toContain("no track");
    expect(html).toContain("first seen —");
  });

  it("never renders hidden answers", () => {
    const html = buildSelectedPanelHtml({
      state: { id: "T01", stage: "classified", behavior: "steady-transit", track: "confirmed" },
      behaviorHint: "steady, level flight — often friendly",
      observer: "station",
      sensor: "visual",
      tracked: true,
      firstSeenMs: 1000,
      pos: { x: 0, z: 0, alt: 45 },
      speedClass: "medium",
      flightPattern: "straight-transit",
    });
    expect(html).not.toContain("classification_label");
    expect(html).not.toContain("expected_response");
  });

  it("never renders geographic coordinates", () => {
    // Position is a sim-grid reference, not a real-world fix.
    const html = buildSelectedPanelHtml({
      state: { id: "T01", stage: "spawned", behavior: "orbiting", track: "confirmed" },
      behaviorHint: "",
      observer: "station",
      sensor: "visual",
      tracked: true,
      firstSeenMs: 500,
      pos: { x: -70, z: 20, alt: 45 },
      speedClass: "slow",
      flightPattern: "orbit-hold",
    }).toLowerCase();
    for (const leaked of ["latitude", "longitude", "gps", "classification_label", "expected_response"]) {
      expect(html).not.toContain(leaked);
    }
    expect(html).toContain("x -70");
  });
});
