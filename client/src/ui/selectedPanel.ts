// Right contextual panel: what is known about the selected observed contact
// and what the trainee may do next. Renders only trainee-visible evidence
// (live grid position, workflow stage, behavior signature, declared speed and
// pattern, track state, sensor provenance); never labels, responses,
// geographic coordinates, or unspawned contacts. The HTML builder is pure
// (node testable); the mount wrapper needs DOM like the other panel mounts.

import type { HudStage, HudThreatState } from "./hud";

export interface GridPosition {
  /** World-unit grid reference: east-west, north-south, altitude. */
  x: number;
  z: number;
  alt: number;
}

export interface SelectedContact {
  state: HudThreatState;
  /** Shared-doctrine meaning of the behavior signature, from the cue legend. */
  behaviorHint: string;
  /** Which observer holds the contact ("station" | "airborne"). */
  observer: string;
  /** Which sensor holds it ("visual" | "radar"). */
  sensor: "visual" | "radar";
  /** Whether any sensor track currently holds the contact. */
  tracked: boolean;
  /** When the contact first entered the sensor picture, if known. */
  firstSeenMs: number | null;
  /** Live grid position, null while the contact has no visible fix. */
  pos: GridPosition | null;
  /** Declared speed class, from the redacted scenario view. */
  speedClass: string | null;
  /** Assigned flight pattern, from the redacted scenario view. */
  flightPattern: string | null;
}

/** Signed world-unit grid component, e.g. "+123" or "-456". */
export function formatGrid(value: number): string {
  const rounded = Math.round(value);
  return `${rounded < 0 ? "-" : "+"}${Math.abs(rounded)}`;
}

export function formatPosition(pos: GridPosition | null): string {
  if (!pos) return "—";
  return `X ${formatGrid(pos.x)} · Z ${formatGrid(pos.z)} · ALT ${Math.round(pos.alt)}u`;
}

const NEXT_STEP: Record<HudStage, string> = {
  pending: "Awaiting spawn — no action available.",
  spawned: "<b>DETECT</b> to log this contact.",
  detected: "Choose a <b>classification</b> below.",
  classified: "Choose a <b>response</b> below.",
  responded: "Contact resolved — no further action.",
};

export function buildSelectedPanelHtml(contact: SelectedContact | null): string {
  if (!contact) {
    return `<span class="hud-sec-title">Selected contact</span>`
      + `<p class="sel-empty">No contact selected. Click a contact in the list or on the sensor display.</p>`;
  }
  const { state } = contact;
  const seen = contact.firstSeenMs !== null
    ? `first seen ${(contact.firstSeenMs / 1000).toFixed(1)}s`
    : "first seen —";
  return `<span class="hud-sec-title">Selected contact</span>`
    + `<div class="sel-head"><span class="sel-id">${state.id}</span>`
    + `<span class="sel-stage is-${state.stage}">${state.stage}</span></div>`
    + `<div class="sel-rows">`
    + `<div><span>Position</span><span>${formatPosition(contact.pos)}</span></div>`
    + `<div><span>Signature</span><span>${state.behavior}</span></div>`
    + `<div><span>Doctrine</span><span>${contact.behaviorHint}</span></div>`
    + `<div><span>Speed</span><span>${contact.speedClass ?? "—"}</span></div>`
    + `<div><span>Pattern</span><span>${contact.flightPattern ?? "—"}</span></div>`
    + `<div><span>Track</span><span>${contact.tracked ? state.track : "no track"}</span></div>`
    + `<div><span>Sensor</span><span>${contact.observer} · ${contact.sensor}</span></div>`
    + `<div><span>Observed</span><span>${seen}</span></div>`
    + `</div>`
    + `<p class="sel-next">${NEXT_STEP[state.stage]}</p>`;
}

export interface SelectedPanel {
  root: HTMLElement;
  set(contact: SelectedContact | null): void;
}

export function mountSelectedPanel(root: HTMLElement): SelectedPanel {
  const element = document.createElement("div");
  element.id = "selected-panel";
  element.className = "panel";
  root.appendChild(element);

  let lastKey = "";
  return {
    root: element,
    set(contact) {
      const key = contact
        ? `${contact.state.id}|${contact.state.stage}|${contact.state.behavior}|${contact.state.track}`
          + `|${contact.observer}|${contact.sensor}|${contact.tracked}|${contact.firstSeenMs ?? "-"}`
          + `|${contact.pos ? `${Math.round(contact.pos.x)},${Math.round(contact.pos.z)},${Math.round(contact.pos.alt)}` : "-"}`
          + `|${contact.speedClass ?? "-"}|${contact.flightPattern ?? "-"}`
        : "none";
      if (key === lastKey) return;
      lastKey = key;
      element.innerHTML = buildSelectedPanelHtml(contact);
    },
  };
}
