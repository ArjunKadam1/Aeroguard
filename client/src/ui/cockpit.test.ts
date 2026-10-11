import { describe, expect, it } from "vitest";
import {
  attitudeIndicatorSvg,
  buildCockpitHtml,
  controlHelpHtml,
  headingTapeMarks,
  throttleBar,
  verticalTape,
  type InstrumentData,
} from "./cockpit";

const data: InstrumentData = {
  altitude: 120, speed: 24, throttle: 0.62, pitch: 0.2, roll: -0.4, heading: 1.57,
};

describe("attitudeIndicatorSvg", () => {
  it("draws a horizon that translates with pitch", () => {
    const level = attitudeIndicatorSvg(0, 0);
    const noseDown = attitudeIndicatorSvg(0.5, 0);
    expect(level).toContain("<svg");
    // A different pitch must move the horizon line.
    expect(noseDown).not.toBe(level);
  });

  it("rotates with bank angle", () => {
    const left = attitudeIndicatorSvg(0, -0.5);
    const right = attitudeIndicatorSvg(0, 0.5);
    expect(left).not.toBe(right);
    expect(left).toContain("rotate(");
  });

  it("renders level and inverted attitudes without NaN", () => {
    for (const [p, r] of [[0, 0], [1.3, -1.3], [-0.9, 0.8]]) {
      const svg = attitudeIndicatorSvg(p, r);
      expect(svg).not.toContain("NaN");
      expect(svg).toContain("</svg>");
    }
  });

  it("includes an accessible label", () => {
    expect(attitudeIndicatorSvg(0.3, 0.2)).toContain('role="img"');
    expect(attitudeIndicatorSvg(0.3, 0.2)).toContain("aria-label");
  });
});

describe("headingTapeMarks", () => {
  it("renders cardinal points", () => {
    const html = headingTapeMarks(0);
    expect(html).toContain(">N<");
  });

  it("wraps heading past 360 without breaking", () => {
    const html = headingTapeMarks(7); // ~400 degrees
    expect(html).not.toContain("NaN");
    expect(html).toContain("ht-mark");
  });
});

describe("instruments", () => {
  it("renders a vertical tape with a unit", () => {
    expect(verticalTape(120.4, "ALT")).toContain("120");
    expect(verticalTape(24, "SPD", "m/s")).toContain("m/s");
  });

  it("clamps the throttle bar to 0-100", () => {
    expect(throttleBar(0.5)).toContain("width:50%");
    expect(throttleBar(2)).toContain("width:100%");
    expect(throttleBar(-1)).toContain("width:0%");
  });
});

describe("buildCockpitHtml", () => {
  it("includes attitude, heading and throttle", () => {
    const html = buildCockpitHtml(data, "fpv", false);
    expect(html).toContain("adi");
    expect(html).toContain("htape-read");
    expect(html).toContain("FPV");
    expect(html).toContain("62%");
  });

  it("shows the camera mode", () => {
    expect(buildCockpitHtml(data, "gimbal", false)).toContain("GIMBAL");
    expect(buildCockpitHtml(data, "chase", false)).toContain("CHASE");
  });

  it("marks the indicator as pinned in FPV only", () => {
    expect(buildCockpitHtml(data, "fpv", true)).toContain("adi-pin");
    expect(buildCockpitHtml(data, "chase", false)).not.toContain("adi-pin");
  });

  it("never emits NaN for extreme attitudes", () => {
    const html = buildCockpitHtml(
      { altitude: 1e9, speed: -5, throttle: 9, pitch: 99, roll: -99, heading: 99 },
      "fpv",
      true,
    );
    expect(html).not.toContain("NaN");
  });
});

describe("controlHelpHtml", () => {
  it("renders every key binding", () => {
    const html = controlHelpHtml([["W", "throttle"], ["C", "camera"]]);
    expect(html).toContain("<kbd>W</kbd>");
    expect(html).toContain("camera");
  });
});