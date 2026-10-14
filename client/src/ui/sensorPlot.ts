// 2D visual-sector plot for the ground station: the default sensor view. A
// north-up plan display centred on the mast, showing range rings, the live
// mast look wedge, and one blip per sensor track -- nothing else. Unobserved
// space is blank: unspawned or unseen contacts never reach this component,
// and tracks carry no classification truth (see sim/observation.ts Track),
// so there is nothing here to leak. Blip style mirrors certainty:
// confirmed solid, tentative hollow, coasting dim. The HTML builder is pure
// (node testable); the mount wrapper needs DOM like the other panel mounts.

import {
  STATION_HALF_FOV,
  STATION_VISUAL_RANGE,
  bearingDegOf,
  stationObserver,
  trackState,
  type Track,
} from "../sim/observation";

const SIZE = 260;
const CENTER = SIZE / 2;
const RADIUS = SIZE / 2 - 16;
const HALF_FOV_DEG = (STATION_HALF_FOV * 180) / Math.PI;

function toXY(bearingDeg: number, range: number): { x: number; y: number } {
  const radians = (bearingDeg * Math.PI) / 180;
  const radius = Math.min(1, range / STATION_VISUAL_RANGE) * RADIUS;
  // Bearing 0 = up (north, -Z), clockwise -- same frame as the radar scope.
  return {
    x: CENTER + radius * Math.sin(radians),
    y: CENTER - radius * Math.cos(radians),
  };
}

/** Screen bearing of the mast look direction, derived from the same observer the sensor uses. */
export function lookBearingDeg(heading: number): number {
  const look = stationObserver(heading).lookDirection;
  return bearingDegOf({ x: look.x, y: 0, z: look.z });
}

function wedgePath(lookBearing: number): string {
  const start = toXY(lookBearing - HALF_FOV_DEG, STATION_VISUAL_RANGE);
  const end = toXY(lookBearing + HALF_FOV_DEG, STATION_VISUAL_RANGE);
  return `M ${CENTER} ${CENTER} L ${start.x.toFixed(1)} ${start.y.toFixed(1)}`
    + ` A ${RADIUS} ${RADIUS} 0 0 1 ${end.x.toFixed(1)} ${end.y.toFixed(1)} Z`;
}

export function buildSensorPlotHtml(
  tracks: readonly Track[],
  tick: number,
  heading: number,
  selected: string | null,
): string {
  const look = lookBearingDeg(heading);
  const rings = [1 / 3, 2 / 3, 1]
    .map((fraction) => {
      const radius = (fraction * RADIUS).toFixed(1);
      const label = Math.round(fraction * STATION_VISUAL_RANGE).toString();
      return `<circle cx="${CENTER}" cy="${CENTER}" r="${radius}" class="plot-ring"/>`
        + `<text x="${CENTER + Number(radius) * 0.72}" y="${CENTER - Number(radius) * 0.72}" class="plot-ring-label">${label}</text>`;
    })
    .join("");
  const blips = tracks
    .map((track) => {
      const state = trackState(track, tick);
      const { x, y } = toXY(track.bearingDeg, track.range);
      const classes = `plot-blip plot-${state}${track.id === selected ? " is-selected" : ""}`;
      const radius = state === "confirmed" ? 5 : 4;
      return `<g class="${classes}" data-track="${track.id}" tabindex="0" role="button" aria-label="Select contact ${track.id}, ${state}">`
        + `<title>${track.id} · ${state}</title>`
        + `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${radius}"/>`
        + `<text x="${(x + 8).toFixed(1)}" y="${(y + 4).toFixed(1)}">${track.id}</text></g>`;
    })
    .join("");
  const empty = tracks.length === 0
    ? `<text x="${CENTER}" y="${CENTER - 8}" class="plot-empty">NO CONTACTS IN SECTOR</text>`
    + `<text x="${CENTER}" y="${CENTER + 10}" class="plot-empty-hint">hold S to sweep the mast</text>`
    : "";
  return `<svg viewBox="0 0 ${SIZE} ${SIZE}" class="plot-scope" role="img" aria-label="Visual sector plot">`
    + `<line x1="${CENTER}" y1="8" x2="${CENTER}" y2="${SIZE - 8}" class="plot-axis"/>`
    + `<line x1="8" y1="${CENTER}" x2="${SIZE - 8}" y2="${CENTER}" class="plot-axis"/>`
    + `<text x="${CENTER}" y="14" class="plot-north">N</text>`
    + rings
    + `<path d="${wedgePath(look)}" class="plot-wedge"/>`
    + `<circle cx="${CENTER}" cy="${CENTER}" r="4" class="plot-mast"><title>mast</title></circle>`
    + blips
    + empty
    + `</svg>
    <div class="plot-legend"><span class="plot-confirmed">● confirmed</span>`
    + `<span class="plot-tentative">○ tentative</span><span class="plot-coasting">● coasting</span></div>
    <div class="plot-foot"><span>VISUAL SECTOR · ${STATION_VISUAL_RANGE}u · ±${Math.round(HALF_FOV_DEG)}° · no radar</span>`
    + `<span>click a blip to select</span></div>`;
}

export interface SensorPlotPanel {
  root: HTMLElement;
  setTracks(tracks: readonly Track[], tick: number, heading: number, selected: string | null): void;
}

export function mountSensorPlot(root: HTMLElement, onSelect: (id: string) => void): SensorPlotPanel {
  const element = document.createElement("div");
  element.id = "sensor-plot";
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
    setTracks(tracks, tick, heading, selected) {
      const key = `${tick}|${heading.toFixed(2)}|${selected ?? "-"}|`
        + tracks.map((t) => `${t.id}:${t.lastTick}:${Math.round(t.bearingDeg)}:${Math.round(t.range)}`).join(",");
      if (key === lastKey) return;
      lastKey = key;
      element.innerHTML = buildSensorPlotHtml(tracks, tick, heading, selected);
    },
  };
}
