// View switcher bar: 2D Sensors (default) vs 3D World. Switching only shows
// or hides views and skips the 3D draw -- it never touches the scenario,
// clock, tracks, selection, or events. The HTML builder is pure (node
// testable); the mount wrapper needs DOM like the other panel mounts.

import type { ViewMode } from "../state/viewMode";
import { VIEW_MODE_LABELS } from "../state/viewMode";

const ORDER: ViewMode[] = ["sensors", "split", "world"];

export function buildViewBarHtml(active: ViewMode): string {
  const buttons = ORDER
    .map((mode) => {
      const pressed = mode === active ? "true" : "false";
      const selected = mode === active ? " is-active" : "";
      return `<button type="button" class="view-bar-btn${selected}" data-view="${mode}" aria-pressed="${pressed}">`
        + `${VIEW_MODE_LABELS[mode]}</button>`;
    })
    .join("");
  return `<div class="view-bar" role="group" aria-label="View mode">${buttons}</div>`;
}

export interface ViewBar {
  root: HTMLElement;
  set(active: ViewMode): void;
}

export function mountViewBar(root: HTMLElement, onSwitch: (mode: ViewMode) => void): ViewBar {
  const element = document.createElement("div");
  element.id = "view-bar";
  root.appendChild(element);

  function render(active: ViewMode): void {
    element.innerHTML = buildViewBarHtml(active);
  }

  element.addEventListener("click", (event) => {
    const target = (event.target as HTMLElement).closest?.("[data-view]") as HTMLElement | null;
    const mode = target?.dataset.view;
    if (mode === "sensors" || mode === "split" || mode === "world") onSwitch(mode);
  });

  return {
    root: element,
    set: (active) => render(active),
  };
}
