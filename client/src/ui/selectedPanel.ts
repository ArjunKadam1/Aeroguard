// Right contextual panel: what is known about the selected observed contact
// and what the trainee may do next. Renders only trainee-visible evidence
// (live grid position, workflow stage, behavior signature, declared speed and
// pattern, track state, sensor provenance); never labels, responses,
// geographic coordinates, or unspawned contacts. The HTML builder is pure
// (node testable); the mount wrapper needs DOM like the other panel mounts.

import { isResponseClass, type ResponseClass, type ResponseState } from "../sim/response";
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
  /** Advisory assessment guidance from observable evidence, when a decision is open. */
  guidance?: string | null;
  /** Simulated-response assistant state, once the contact is classified. */
  assistant?: ResponseAssistantView | null;
}

/** A workflow action the trainee can trigger from the assistant section. */
export type ResponseAssistantAction = "request" | "approve" | "reject" | "cancel" | "reopen";

/**
 * The simulated-response workflow, projected for display. Every value comes
 * from the workflow model; this module supplies trainee-facing wording only.
 * No probability, no expected response, and no real-world action language:
 * approval is an abstract simulation authorization.
 */
export interface ResponseAssistantView {
  state: ResponseState;
  /** Abstract class of the current proposal, when one exists. */
  responseClass: ResponseClass | null;
  /** Proposed abstract measure, when a proposal exists. */
  measure: string | null;
  /** Plain-language basis for the proposal. */
  basis: string | null;
  /** Terminal outcome, once one was reached. */
  outcome: "neutralized" | "failed" | null;
  /** Non-numeric explanation of the outcome. */
  cause: string | null;
  /** Why the simulation is unavailable, when it is. */
  reason: string | null;
}

function assistantHtml(assistant: ResponseAssistantView): string {
  const head = `<div class="ra-head"><span class="ra-title">Response assistant</span>`
    + `<span class="ra-badge">simulated</span></div>`;
  let body: string;
  switch (assistant.state) {
    case "unavailable":
      body = `<p class="ra-note">${assistant.reason
        ?? "Simulated response resolution is unavailable for this scenario."}</p>`;
      break;
    case "ready":
      body = `<p class="ra-note">Request a simulated response for this contact. Nothing is `
        + `executed — approval is yours, and the outcome is a training simulation.</p>`
        + `<div class="ra-actions">`
        + `<button type="button" class="ra-btn" data-ra-action="request" data-ra-class="mitigation">`
        + `Mitigation (simulated)</button>`
        + `<button type="button" class="ra-btn" data-ra-action="request" data-ra-class="weapon-class">`
        + `Weapon-class (simulated)</button>`
        + `</div>`;
      break;
    case "awaiting_approval":
      body = (assistant.responseClass ? `<p class="ra-class-chip">${assistant.responseClass}</p>` : "")
        + (assistant.measure ? `<p class="ra-measure">${assistant.measure}</p>` : "")
        + (assistant.basis ? `<p class="ra-basis">${assistant.basis}</p>` : "")
        + `<div class="ra-actions">`
        + `<button type="button" class="ra-btn" data-ra-action="approve">Approve</button>`
        + `<button type="button" class="ra-btn" data-ra-action="reject">Reject</button>`
        + `</div>`;
      break;
    case "in_progress":
      body = `<p class="ra-note">Processing the approved simulated response…</p>`
        + `<button type="button" class="ra-btn" data-ra-action="cancel">Cancel simulation</button>`;
      break;
    case "neutralized":
      body = `<p class="ra-outcome ra-gain">Simulated neutralization confirmed.</p>`
        + (assistant.cause ? `<p class="ra-note">${assistant.cause}</p>` : "");
      break;
    case "failed":
      body = `<p class="ra-outcome ra-loss">Simulation unsuccessful — no neutralization.</p>`
        + (assistant.cause ? `<p class="ra-note">${assistant.cause}</p>` : "");
      break;
    case "aborted":
      body = `<p class="ra-outcome">Aborted — the simulation produced no result.</p>`;
      break;
    case "rejected":
      body = `<p class="ra-note">Proposal rejected — nothing was run.</p>`
        + `<button type="button" class="ra-btn" data-ra-action="reopen">Request again</button>`;
      break;
  }
  return `<div class="ra-sec">${head}${body}</div>`;
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
    + (contact.guidance ? `<p class="sel-guidance">${contact.guidance}</p>` : "")
    + `<p class="sel-next">${NEXT_STEP[state.stage]}</p>`
    + (contact.assistant ? assistantHtml(contact.assistant) : "");
}

export interface SelectedPanel {
  root: HTMLElement;
  set(contact: SelectedContact | null): void;
}

export function mountSelectedPanel(
  root: HTMLElement,
  onAssistant: (action: ResponseAssistantAction, responseClass?: ResponseClass) => void = () => {},
): SelectedPanel {
  const element = document.createElement("div");
  element.id = "selected-panel";
  element.className = "panel";
  root.appendChild(element);

  element.addEventListener("click", (event) => {
    const target = (event.target as HTMLElement).closest?.("[data-ra-action]") as HTMLElement | null;
    const action = target?.dataset.raAction as ResponseAssistantAction | undefined;
    if (!action) return;
    // The class comes only from the rendered data attribute and is validated
    // against the model's known classes; anything else reads as undefined and
    // the caller applies its primary-action default.
    const raw = target?.dataset.raClass;
    onAssistant(action, isResponseClass(raw) ? raw : undefined);
  });

  let lastKey = "";
  return {
    root: element,
    set(contact) {
      const key = contact
        ? `${contact.state.id}|${contact.state.stage}|${contact.state.behavior}|${contact.state.track}`
          + `|${contact.observer}|${contact.sensor}|${contact.tracked}|${contact.firstSeenMs ?? "-"}`
          + `|${contact.pos ? `${Math.round(contact.pos.x)},${Math.round(contact.pos.z)},${Math.round(contact.pos.alt)}` : "-"}`
          + `|${contact.speedClass ?? "-"}|${contact.flightPattern ?? "-"}`
          + `|${contact.guidance ?? "-"}`
          + `|${contact.assistant ? `${contact.assistant.state}:${contact.assistant.outcome ?? "-"}`
            + `:${contact.assistant.responseClass ?? "-"}` : "-"}`
        : "none";
      if (key === lastKey) return;
      lastKey = key;
      element.innerHTML = buildSelectedPanelHtml(contact);
    },
  };
}
