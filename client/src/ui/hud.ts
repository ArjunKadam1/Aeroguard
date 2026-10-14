import type { PublicScenario } from "../api/types";
import {
  SCOUT_RADAR_RANGE,
  SCOUT_VISUAL_RANGE,
  STATION_VISUAL_RANGE,
  RADAR_PERIOD_S,
} from "../sim/observation";
import { buildSensorStatusHtml } from "./sensors";

export type HudStage = "pending" | "spawned" | "detected" | "classified" | "responded";

export interface HudThreatState {
  id: string;
  stage: HudStage;
  /** Observable behavior signature for this contact. */
  behavior: string;
  /** Track lifecycle state: confirmed, tentative, coasting, or unseen. */
  track: string;
}

export interface Hud {
  root: HTMLElement;
  setRemaining(seconds: number): void;
  setSelected(id: string | null): void;
  setThreats(states: HudThreatState[]): void;
}

// Color is derived from the threat id hash only (same rule as the 3D threat cores
// in sim/threats.ts) so the HUD never reveals the ground-truth classification.
const DOT_COLORS = ["#ff6b35", "#22d3ee", "#84cc16", "#d946ef", "#f59e0b"] as const;

const STAGE_LABEL: Record<HudStage, string> = {
  pending: "waiting",
  spawned: "on screen",
  detected: "detected",
  classified: "classified",
  responded: "resolved",
};

function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) & 0x7fffffff;
  }
  return hash;
}

export function threatDotColor(id: string): string {
  return DOT_COLORS[hashString(id) % DOT_COLORS.length];
}

export function buildHudHtml(
  scenario: PublicScenario,
  threats: HudThreatState[],
  selected: string | null,
  remaining: number,
  observer: "station" | "scout" = "station",
): string {
  const rows = threats
    .map((t) => {
      const isSelected = t.id === selected;
      const dot = `<span class="hud-dot" style="background:${threatDotColor(t.id)}"></span>`;
      const marker = isSelected ? ` <span class="hud-selected">selected</span>` : "";
      const stageClass = `hud-stage hud-stage-${t.stage}`;
      // Pending contacts carry no countdown: spawn timing is scenario truth,
      // not an observation, and showing it would tell the trainee when to look.
      // The behavior signature is the evidence classification is judged from.
      const hint = scenario.cue_legend[t.behavior] ?? "";
      const behavior = `<span class="hud-behavior" title="${hint}">${t.behavior}</span>`;
      const track = `<span class="hud-track hud-track-${t.track}">${t.track}</span>`;
      return `<li class="hud-threat${isSelected ? " is-selected" : ""}" data-threat="${t.id}">`
        + `${dot}<span class="hud-id">${t.id}</span>${marker}${behavior}${track}`
        + `<span class="${stageClass}">${STAGE_LABEL[t.stage]}</span></li>`;
    })
    .join("");
  const visibility = scenario.visibility === "clear" ? "" : ` &middot; vis ${scenario.visibility}`;
  const legend = Object.entries(scenario.cue_legend)
    .map(([behavior, meaning]) => `<div><span>${behavior}</span><span>${meaning}</span></div>`)
    .join("");
  const sensors = buildSensorStatusHtml(
    observer,
    observer === "scout"
      ? { visualRange: SCOUT_VISUAL_RANGE, radarRange: SCOUT_RADAR_RANGE, radarPeriod: RADAR_PERIOD_S }
      : { visualRange: STATION_VISUAL_RANGE, radarRange: 0, radarPeriod: RADAR_PERIOD_S },
    {
      sensorQuality: scenario.sensor_quality,
      night: scenario.time_of_day === "night",
      visibility: scenario.visibility,
    },
  );
  return `
    <div><strong>${scenario.environment} / ${scenario.time_of_day}</strong></div>
    <div>difficulty ${scenario.difficulty} &middot; sensor ${scenario.sensor_quality.toFixed(2)}${visibility}</div>
    <div>time left: ${Math.max(0, Math.ceil(remaining))}s</div>
    <div class="hud-threat-count">${threats.length} contact${threats.length === 1 ? "" : "s"} observed</div>
    <ul class="hud-threats">${rows}</ul>
    <div class="hud-legend"><span class="hud-legend-title">SIGNATURES</span>${legend}</div>
    ${sensors}`;
}

export function mountHud(
  root: HTMLElement,
  scenario: PublicScenario,
  observer: "station" | "scout",
  onSelect: (id: string) => void = () => {},
): Hud {
  const element = document.createElement("div");
  element.id = "hud";
  element.className = "panel";
  root.appendChild(element);

  // Rows are the 2D selection path alongside the plot/scope blips: clicking
  // one selects the contact exactly like clicking its blip.
  element.addEventListener("click", (event) => {
    const target = (event.target as HTMLElement).closest?.("[data-threat]") as HTMLElement | null;
    const id = target?.dataset.threat;
    if (id) onSelect(id);
  });

  let selected: string | null = null;
  let remaining = scenario.duration_seconds;
  // Nothing is listed until observed: unspawned contacts are not trainee
  // knowledge, so the caller only passes spawned-and-later stages.
  let threats: HudThreatState[] = [];

  function render(): void {
    element.innerHTML = buildHudHtml(scenario, threats, selected, remaining, observer);
  }
  render();

  return {
    root: element,
    setRemaining: (seconds) => {
      remaining = seconds;
      render();
    },
    setSelected: (id) => {
      selected = id;
      render();
    },
    setThreats: (states) => {
      threats = states;
      render();
    },
  };
}

