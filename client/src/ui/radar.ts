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

function cardinalMarks(maxRange: number): string {
  const names: Array<[string, number]> = [["N", 0], ["E", 90], ["S", 180], ["W", 270]];
  const labels = names
    .map(([name, deg]) => {
      // Cardinals sit inside the rim, clear of the outer ring line and the
      // viewBox edge (1.02× put them on top of both).
      const p = toXY(deg, maxRange * 0.86, maxRange);
      return `<text x="${p.x.toFixed(1)}" y="${(p.y + 3).toFixed(1)}" class="radar-cardinal" text-anchor="middle">${name}</text>`;
    })
    .join("");
  const ticks = Array.from({ length: 12 }, (_, i) => i * 30)
    .map((deg) => {
      const outer = toXY(deg, maxRange, maxRange);
      const inner = toXY(deg, maxRange * 0.95, maxRange);
      return `<line x1="${inner.x.toFixed(1)}" y1="${inner.y.toFixed(1)}"`
        + ` x2="${outer.x.toFixed(1)}" y2="${outer.y.toFixed(1)}" class="radar-tick"/>`;
    })
    .join("");
  return ticks + labels;
}

export function buildRadarHtml(
  tracks: readonly Track[],
  maxRange: number,
  tick: number,
  selectedId: string | null = null,
  freshIds: readonly string[] = [],
  altById: Record<string, number> = {},
): string {
  const rings = [1 / 3, 2 / 3, 1]
    .map((fraction, index) => {
      const radius = (fraction * RADIUS).toFixed(1);
      const label = Math.round(fraction * maxRange).toString();
      const opacity = [0.45, 0.65, 1][index];
      return `<circle cx="${CENTER}" cy="${CENTER}" r="${radius}" class="radar-ring" opacity="${opacity}"/>`
        + `<text x="${CENTER + Number(radius) * 0.72}" y="${CENTER - Number(radius) * 0.72}" class="radar-ring-label">${label}</text>`;
    })
    .join("");
  // Sweep hand rotates one eighth turn per sweep: the scope visibly revisits,
  // which is why blips blink and coast instead of sitting still. The faint
  // wedge is rigidly slaved to the same hand angle and clock -- it visualizes
  // sweep cadence only. The radar model itself is omnidirectional (range-only
  // detection every sweep), so the wedge grants no directional coverage.
  const sweepAngle = (tick % 8) * 45;
  const wedgeStart = toXY(sweepAngle - 18, maxRange, maxRange);
  const wedgeEnd = toXY(sweepAngle + 18, maxRange, maxRange);
  const sweepWedge = `<path d="M ${CENTER} ${CENTER} L ${wedgeStart.x.toFixed(1)} ${wedgeStart.y.toFixed(1)}`
    + ` A ${RADIUS} ${RADIUS} 0 0 1 ${wedgeEnd.x.toFixed(1)} ${wedgeEnd.y.toFixed(1)} Z"`
    + ` class="radar-sweep-wedge"/>`;
  const sweepPing = `<circle cx="${CENTER}" cy="${CENTER}" r="${RADIUS}" class="radar-ping"/>`;
  const blips = tracks
    .map((track) => {
      const visual = track.lastSource === "visual";
      const fresh = track.lastTick === tick;
      const { x, y } = toXY(track.bearingDeg, track.range, maxRange);
      const state = visual ? "is-visual" : fresh ? "is-fresh" : "is-stale";
      const title = visual ? `${track.id} · visual hold` : `${track.id} · radar`;
      const selected = track.id === selectedId;
      const isNew = freshIds.includes(track.id);
      // Labels anchor away from the scope center so nearby blips fan outward.
      const leftSide = x < CENTER;
      const anchor = leftSide ? "end" : "start";
      const lx = x + (leftSide ? -9 : 9);
      return `<g class="radar-blip ${state}${selected ? " is-selected" : ""}${isNew ? " is-new" : ""}" data-track="${track.id}" tabindex="0" role="button" aria-label="Select contact ${title}">`
        + `<title>${title}</title>`
        + (selected ? `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="9" class="radar-halo"/>` : "")
        + (isNew ? `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="8" class="radar-new-ring"/>` : "")
        + `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${fresh && !visual ? 5 : 4}" class="radar-mark"/>`
        + `<text x="${lx.toFixed(1)}" y="${(y + 4).toFixed(1)}" text-anchor="${anchor}">${track.id}</text></g>`;
    })
    .join("");
  const empty = tracks.length === 0
    ? `<text x="${CENTER}" y="${CENTER - 6}" class="radar-empty">SCOPE CLEAR</text>`
    + `<text x="${CENTER}" y="${CENTER + 12}" class="radar-empty-hint">no tracks held</text>`
    : "";
  // Selected-track readout: bearing, range, sensor source, and freshness for
  // the contact being worked -- numbers only, never identity or answers.
  const chosen = selectedId ? tracks.find((t) => t.id === selectedId) : undefined;
  const chosenAlt = selectedId && altById[selectedId] !== undefined ? ` · ALT ${altById[selectedId]}u` : "";
  const readout = chosen
    ? `<div class="radar-readout">${chosen.id} · ${String(Math.round(chosen.bearingDeg)).padStart(3, "0")}°`
      + ` · ${Math.round(chosen.range)}u${chosenAlt} · ${chosen.lastSource === "visual" ? "visual hold" : "radar"}`
      + ` · ${chosen.lastTick === tick ? "fresh" : "coasting"}</div>`
    : `<div class="radar-readout is-empty">— no selection —</div>`;
  return `<svg viewBox="0 0 ${SIZE} ${SIZE}" class="radar-scope" role="img" aria-label="Radar scope">`
    + cardinalMarks(maxRange)
    + rings
    + sweepWedge
    + `<line x1="${CENTER}" y1="${CENTER}" x2="${CENTER}" y2="${CENTER - RADIUS}" class="radar-sweep" transform="rotate(${sweepAngle} ${CENTER} ${CENTER})"/>`
    + sweepPing
    + blips
    + empty
    + `</svg>
    ${readout}
    <div class="radar-legend"><span class="radar-lg-radar">● radar</span>`
    + `<span class="radar-lg-visual">○ visual hold</span><span class="radar-lg-stale">● coasting</span></div>
    <div class="radar-foot"><span>RADAR · ${maxRange}u</span><span>click a blip to select</span></div>`;
}

export interface RadarPanel {
  root: HTMLElement;
  setTracks(
    tracks: readonly Track[], maxRange: number, tick: number,
    selected?: string | null, freshIds?: readonly string[], altById?: Record<string, number>,
  ): void;
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
    setTracks(
    tracks, maxRange, tick, selected = null, freshIds = [], altById: Record<string, number> = {},
  ) {
      const key = `${tick}|${selected ?? "-"}|${[...freshIds].sort().join(",")}|${selected && altById[selected] !== undefined ? altById[selected] : "-"}|${tracks.map((t) => `${t.id}:${t.lastTick}:${Math.round(t.bearingDeg)}:${Math.round(t.range)}`).join(",")}`;
      if (key === lastKey) return;
      lastKey = key;
      element.innerHTML = buildRadarHtml(tracks, maxRange, tick, selected, freshIds, altById);
    },
  };
}
