import { describe, expect, it } from "vitest";
import { buildViewBarHtml } from "./viewBar";

describe("view bar", () => {
  it("offers all three views with the active one pressed", () => {
    const html = buildViewBarHtml("sensors");
    expect(html).toContain('data-view="sensors"');
    expect(html).toContain('data-view="split"');
    expect(html).toContain('data-view="world"');
    expect(html).toContain("2D Sensors");
    expect(html).toContain("Split");
    expect(html).toContain("3D World");
    expect(html).toContain('data-view="sensors" aria-pressed="true"');
    expect(html).toContain('data-view="split" aria-pressed="false"');
    expect(html).toContain('data-view="world" aria-pressed="false"');
  });

  it("moves the pressed state when the split view is active", () => {
    const html = buildViewBarHtml("split");
    expect(html).toContain('data-view="split" aria-pressed="true"');
    expect(html).toContain('data-view="sensors" aria-pressed="false"');
  });

  it("moves the pressed state when the world view is active", () => {
    const html = buildViewBarHtml("world");
    expect(html).toContain('data-view="world" aria-pressed="true"');
    expect(html).toContain('data-view="sensors" aria-pressed="false"');
  });
});
