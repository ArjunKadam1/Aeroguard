// View-mode state for the 2D-first pivot: the trainee works in the sensor
// view by default and can switch to the 3D world without disturbing the
// session. The store holds only which view is shown -- scenario, clock,
// tracks, selection, and events live in the session and are untouched by
// switching. Pure logic, no DOM, so it is unit-testable in node.

export type ViewMode = "sensors" | "split" | "world";

export const DEFAULT_VIEW_MODE: ViewMode = "sensors";

export const VIEW_MODE_LABELS: Record<ViewMode, string> = {
  sensors: "2D Sensors",
  split: "Split",
  world: "3D World",
};

export interface ViewModeStore {
  get(): ViewMode;
  set(mode: ViewMode): void;
  subscribe(listener: (mode: ViewMode) => void): () => void;
}

export function createViewModeStore(initial: ViewMode = DEFAULT_VIEW_MODE): ViewModeStore {
  let current = initial;
  const listeners = new Set<(mode: ViewMode) => void>();
  return {
    get: () => current,
    set: (mode) => {
      if (mode === current) return;
      current = mode;
      for (const listener of listeners) listener(current);
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
