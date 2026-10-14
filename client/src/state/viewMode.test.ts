import { describe, expect, it, vi } from "vitest";
import { createViewModeStore, DEFAULT_VIEW_MODE, VIEW_MODE_LABELS } from "./viewMode";

describe("view mode store", () => {
  it("defaults to the 2D sensor view", () => {
    expect(createViewModeStore().get()).toBe("sensors");
    expect(DEFAULT_VIEW_MODE).toBe("sensors");
  });

  it("labels all three views", () => {
    expect(VIEW_MODE_LABELS.sensors).toBe("2D Sensors");
    expect(VIEW_MODE_LABELS.split).toBe("Split");
    expect(VIEW_MODE_LABELS.world).toBe("3D World");
  });

  it("switches views and notifies subscribers", () => {
    const store = createViewModeStore();
    const seen: string[] = [];
    const unsubscribe = store.subscribe((mode) => seen.push(mode));
    store.set("split");
    expect(store.get()).toBe("split");
    store.set("world");
    expect(seen).toEqual(["split", "world"]);
    store.set("sensors");
    expect(seen).toEqual(["split", "world", "sensors"]);
    unsubscribe();
    store.set("world");
    expect(seen).toEqual(["split", "world", "sensors"]);
  });

  it("does not notify when the mode is unchanged", () => {
    const store = createViewModeStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.set("sensors");
    expect(listener).not.toHaveBeenCalled();
  });
});
