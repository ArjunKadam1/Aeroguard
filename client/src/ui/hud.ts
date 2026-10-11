import type { Scenario } from "../api/types";

export type HudStage = "pending" | "spawned" | "detected" | "classified" | "responded";

export interface HudThreatState {
  id: string;
  stage: HudStage;
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
  scenario: Scenario,
  threats: HudThreatState[],
  selected: string | null,
  remaining: number,
): string {
  const elapsed = Math.max(0, scenario.duration_seconds - remaining);
  const spawnTimes = new Map(scenario.threats.map((t) => [t.id, t.spawn_time]));
  const rows = threats
    .map((t) => {
      const isSelected = t.id === selected;
      const dot = `<span class="hud-dot" style="background:${threatDotColor(t.id)}"></span>`;
      const marker = isSelected ? ` <span class="hud-selected">selected</span>` : "";
      const stageClass = `hud-stage hud-stage-${t.stage}`;
      // A pending threat is not on screen yet, so say when it is expected rather
      // than leaving the trainee looking at an empty sky with no explanation.
      let countdown = "";
      if (t.stage === "pending") {
        const spawn = spawnTimes.get(t.id);
        if (spawn !== undefined) {
          const eta = Math.max(0, Math.ceil(spawn - elapsed));
          countdown = eta > 0 ? ` <span class="hud-eta">in ~${eta}s</span>` : "";
        }
      }
      return `<li class="hud-threat${isSelected ? " is-selected" : ""}" data-threat="${t.id}">`
        + `${dot}<span class="hud-id">${t.id}</span>${marker}${countdown}`
        + `<span class="${stageClass}">${STAGE_LABEL[t.stage]}</span></li>`;
    })
    .join("");
  const visibility = scenario.visibility === "clear" ? "" : ` &middot; vis ${scenario.visibility}`;
  return `
    <div><strong>${scenario.environment} / ${scenario.time_of_day}</strong></div>
    <div>difficulty ${scenario.difficulty} &middot; sensor ${scenario.sensor_quality.toFixed(2)}${visibility}</div>
    <div>time left: ${Math.max(0, Math.ceil(remaining))}s</div>
    <div class="hud-threat-count">${threats.length} threat${threats.length === 1 ? "" : "s"}</div>
    <ul class="hud-threats">${rows}</ul>`;
}

export function mountHud(root: HTMLElement, scenario: Scenario): Hud {
  const element = document.createElement("div");
  element.id = "hud";
  element.className = "panel";
  root.appendChild(element);

  let selected: string | null = null;
  let remaining = scenario.duration_seconds;
  let threats: HudThreatState[] = scenario.threats.map((t) => ({ id: t.id, stage: "pending" }));

  function render(): void {
    element.innerHTML = buildHudHtml(scenario, threats, selected, remaining);
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

