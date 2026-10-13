import { describe, expect, it } from "vitest";
import { buildStationHelpHtml } from "./stationHelp";

describe("station control hints", () => {
  it("lists every station control", () => {
    const html = buildStationHelpHtml();
    expect(html).toContain("Click contact");
    expect(html).toContain("Esc");
    expect(html).toContain("Hold S");
  });

  it("labels the role so the mode is obvious", () => {
    expect(buildStationHelpHtml()).toContain("pan mast");
  });

  it("accepts a custom help table", () => {
    const html = buildStationHelpHtml([["X", "test action"]]);
    expect(html).toContain("<kbd>X</kbd>");
    expect(html).toContain("test action");
  });
});