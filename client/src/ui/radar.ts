// Abstract radar scope for the scouting drone. Bearing/range blips only --
// no identity, no classification, no targeting geometry. Radar-held contacts
// render solid (fresh bright, coasting dim); contacts held by the visual
// sensor render as hollow rings so the trainee can see what the camera holds
// and what only the radar does. Fed with all unified tracks; the styling
// carries the source distinction, so nothing observable is hidden.

import type { Track } from "../sim/observation";

const SIZE = 200;
const CENTER = SIZE / 2;
const RADIUS = SIZE / 2 - 12;

function toXY(bearingDeg: number, range: number, maxRange: number): { x: number; y: number } {
  const radians = (bearingDeg * Math.PI) / 180;
  const radius = Math.min(1, range / maxRange) * RADIUS;
  // Bearing 0 = up (-Z on screen), clockwise.
  return {
    x: CENTER + radius * Math.sin(radians),
    y: CENTER - radius * Math.cos(radians),
  };
}

export function buildRadarHtml(
  tracks: readonly Track[],
  maxRange: number,
  tick: number,
): string {
  const rings = [1 / 3, 2 / 3, 1]
    .map((fraction) => {
      const radius = (fraction * RADIUS).toFixed(1);
      const label = Math.round(fraction * maxRange).toString();
      return `<circle cx="${CENTER}" cy="${CENTER}" r="${radius}" class="radar-ring"/>`
        + `<text x="${CENTER + Number(radius) * 0.72}" y="${CENTER - Number(radius) * 0.72}" class="radar-ring-label">${label}</text>`;
    })
    .join("");
  // Sweep hand rotates one eighth turn per sweep: the scope visibly revisits,
  // which is why blips blink and coast instead of sitting still.
  const sweepAngle = (tick % 8) * 45;
  const blips = tracks
    .map((track) => {
      const visual = track.lastSource === "visual";
      const fresh = track.lastTick === tick;
      const { x, y } = toXY(track.bearingDeg, track.range, maxRange);
      const state = visual ? "is-visual" : fresh ? "is-fresh" : "is-stale";
      const title = visual ? `${track.id} · visual hold` : `${track.id} · radar`;
      return `<g class="radar-blip ${state}" data-track="${track.id}" tabindex="0" role="button" aria-label="Select contact ${title}">`
        + `<title>${title}</title>`
        + `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${fresh && !visual ? 5 : 4}"/>`
        + `<text x="${(x + 8).toFixed(1)}" y="${(y + 4).toFixed(1)}">${track.id}</text></g>`;
    })
    .join("");
  const empty = tracks.length === 0
    ? `<text x="${CENTER}" y="${CENTER}" class="radar-empty">SCOPE CLEAR</text>`
    : "";
  return `<svg viewBox="0 0 ${SIZE} ${SIZE}" class="radar-scope" role="img" aria-label="Radar scope">`
    + rings
    + `<line x1="${CENTER}" y1="${CENTER}" x2="${CENTER}" y2="${CENTER - RADIUS}" class="radar-sweep" transform="rotate(${sweepAngle} ${CENTER} ${CENTER})"/>`
    + blips
    + empty
    + `</svg>
    <div class="radar-legend"><span class="radar-lg-radar">● radar</span>`
    + `<span class="radar-lg-visual">○ visual hold</span><span class="radar-lg-stale">● coasting</span></div>
    <div class="radar-foot"><span>RADAR · ${maxRange}u</span><span>click a blip to select</span></div>`;
}

export interface RadarPanel {
  root: HTMLElement;
  setTracks(tracks: readonly Track[], maxRange: number, tick: number): void;
}

export function mountRadar(root: HTMLElement, onSelect: (id: string) => void): RadarPanel {
  const element = document.createElement("div");
  element.id = "radar";
  element.className = "panel";
  root.appendChild(element);

  let lastKey = "";
  function selectFromEvent(event: Event): void {
    const target = (event.target as HTMLElement).closest?.("[data-track]") as HTMLElement | null;
    const id = target?.dataset.track;
    if (id) onSelect(id);
  }
  element.addEventListener("click", selectFromEvent);
  // Blips are keyboard-focusable buttons: Enter/Space selects like a click.
  element.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      selectFromEvent(event);
    }
  });

  return {
    root: element,
    setTracks(tracks, maxRange, tick) {
      const key = `${tick}|${tracks.map((t) => `${t.id}:${t.lastTick}:${Math.round(t.bearingDeg)}:${Math.round(t.range)}`).join(",")}`;
      if (key === lastKey) return;
      lastKey = key;
      element.innerHTML = buildRadarHtml(tracks, maxRange, tick);
    },
  };
}
