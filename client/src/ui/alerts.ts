// Observable track-state alerts: an event-driven strip that announces what
// changed in the sensor picture -- a contact acquired, a track confirmed, a
// contact coasting or lost. It replaces silent text changes with one attention
// channel, without touching observation, selection gates, or the event log.
//
// Event-driven by construction: the caller diffs the same per-contact states
// it already computes for the HUD, and only when that render key changes, so
// there is no per-frame alert work. Wording comes from track lifecycle states
// alone -- never a classification, a response, or anything the trainee could
// not already see on the scope. Covers the same contacts the HUD lists
// (spawned-and-later scenario contacts); false radar contacts stay scope-only.
//
// The pure diff and HTML builder are node-testable; the mount wrapper needs
// DOM like the other panel mounts.

import type { TrackState } from "../sim/observation";
import type { HudStage } from "./hud";

/** One contact's observable state, the same shape the HUD already renders. */
export interface ObservedState {
  id: string;
  /** Session stage. Not alertable on its own: stage moves are trainee actions. */
  stage: HudStage;
  /** Track lifecycle state, or "unseen" while no track holds the contact. */
  track: TrackState | "unseen";
}

export type TrackAlertKind = "acquired" | "confirmed" | "coasting" | "lost";
/**
 * Gain = the picture improved; loss = certainty or hold was lost; info = a
 * non-urgent workflow status (e.g. an automated proposal awaiting review).
 */
export type TrackAlertTone = "gain" | "loss" | "info";

export interface TrackAlert {
  id: string;
  kind: TrackAlertKind;
  tone: TrackAlertTone;
  text: string;
}

/**
 * Anything the strip can render: an identity, a tone, and the message. Track
 * alerts satisfy this structurally; non-track sources (the simulated-response
 * workflow) reuse the same attention channel without widening the track
 * alert kinds.
 */
export interface AlertLike {
  id: string;
  tone: TrackAlertTone;
  text: string;
}

function alertFor(
  previous: TrackState | "unseen",
  next: TrackState | "unseen",
  id: string,
): TrackAlert | null {
  if (previous === next) return null;
  if (next === "unseen") {
    return { id, kind: "lost", tone: "loss", text: `${id} lost from the sensor picture` };
  }
  if (next === "coasting") {
    return { id, kind: "coasting", tone: "loss", text: `${id} coasting — re-aim a sensor` };
  }
  if (next === "confirmed") {
    return previous === "tentative" || previous === "coasting"
      ? { id, kind: "confirmed", tone: "gain", text: `${id} track confirmed` }
      : { id, kind: "acquired", tone: "gain", text: `${id} acquired — track confirmed` };
  }
  return { id, kind: "acquired", tone: "gain", text: `${id} acquired — tentative track` };
}

/**
 * Alerts for every observable transition between two state snapshots.
 * A contact missing from `previous` reads as unseen, so a first acquisition
 * after spawn alerts. Contacts never leave the list mid-session, and a
 * repeat of the same snapshot pair yields nothing: each transition fires
 * exactly once.
 */
export function trackAlerts(
  previous: readonly ObservedState[],
  next: readonly ObservedState[],
): TrackAlert[] {
  const before = new Map(previous.map((state) => [state.id, state.track]));
  const alerts: TrackAlert[] = [];
  for (const state of next) {
    const alert = alertFor(before.get(state.id) ?? "unseen", state.track, state.id);
    if (alert) alerts.push(alert);
  }
  return alerts;
}

/** One rendered alert: the alert and the session time it fired. */
export interface AlertEntry {
  alert: AlertLike;
  atMs: number;
}

/** How many entries the strip keeps; older ones fall off the bottom. */
export const ALERT_CAP = 5;

/** Newest-first entries with the batch on top and the strip capped. */
export function pushAlerts(
  entries: readonly AlertEntry[],
  alerts: readonly AlertLike[],
  atMs: number,
  cap: number = ALERT_CAP,
): AlertEntry[] {
  return [...alerts.map((alert) => ({ alert, atMs })), ...entries].slice(0, cap);
}

export function buildAlertsHtml(entries: readonly AlertEntry[]): string {
  const title = `<span class="hud-sec-title">Alerts</span>`;
  if (entries.length === 0) {
    return title + `<p class="alerts-empty">Monitoring — alerts appear as the picture changes.</p>`;
  }
  const rows = entries
    .map(({ alert, atMs }) =>
      `<li class="alert-row alert-${alert.tone}" data-alert-id="${alert.id}">`
      + `<span class="alert-time">T+${(atMs / 1000).toFixed(1)}s</span>`
      + `<span class="alert-text">${alert.text}</span></li>`)
    .join("");
  return title + `<ul class="alerts-list" role="log" aria-live="polite">${rows}</ul>`;
}

export interface AlertsPanel {
  root: HTMLElement;
  /** Append alerts (newest first); a no-op for an empty batch. */
  push(alerts: readonly AlertLike[], atMs: number): void;
  /** Current entry count, for tests and callers. */
  size(): number;
}

/**
 * Alert strip mount. Clicking a row focuses its contact through the same
 * selection path as the HUD list and the plots -- selection stays free and
 * gated nowhere. No timers: entries persist until the cap or the session
 * teardown, which owns clear().
 */
export function mountAlerts(
  root: HTMLElement,
  onFocus: (id: string) => void = () => {},
): AlertsPanel {
  const element = document.createElement("div");
  element.id = "alerts-panel";
  element.className = "panel";
  root.appendChild(element);

  let entries: AlertEntry[] = [];

  function render(): void {
    element.innerHTML = buildAlertsHtml(entries);
  }
  render();

  element.addEventListener("click", (event) => {
    const target = (event.target as HTMLElement).closest?.("[data-alert-id]") as HTMLElement | null;
    const id = target?.dataset.alertId;
    if (id) onFocus(id);
  });

  return {
    root: element,
    push(alerts, atMs) {
      if (alerts.length === 0) return;
      entries = pushAlerts(entries, alerts, atMs);
      render();
    },
    size: () => entries.length,
  };
}
