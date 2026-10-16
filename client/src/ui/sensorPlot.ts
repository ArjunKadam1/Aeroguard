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

function cardinalMarks(): string {
  // N/E/S/W at the rim plus minor bearing ticks every 30°.
  const names: Array<[string, number]> = [["N", 0], ["E", 90], ["S", 180], ["W", 270]];
  const labels = names
    .map(([name, deg]) => {
      // Cardinals sit inside the rim, clear of the outer ring line and the
      // viewBox edge.
      const p = toXY(deg, STATION_VISUAL_RANGE * 0.86);
      const anchor = "middle";
      return `<text x="${p.x.toFixed(1)}" y="${(p.y + 3).toFixed(1)}" class="plot-cardinal" text-anchor="${anchor}">${name}</text>`;
    })
    .join("");
  const ticks = Array.from({ length: 12 }, (_, i) => i * 30)
    .map((deg) => {
      const outer = toXY(deg, STATION_VISUAL_RANGE);
      const inner = toXY(deg, STATION_VISUAL_RANGE * 0.95);
      return `<line x1="${inner.x.toFixed(1)}" y1="${inner.y.toFixed(1)}"`
        + ` x2="${outer.x.toFixed(1)}" y2="${outer.y.toFixed(1)}" class="plot-tick"/>`;
    })
    .join("");
  return ticks + labels;
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
    .map((fraction, index) => {
      const radius = (fraction * RADIUS).toFixed(1);
      const label = Math.round(fraction * STATION_VISUAL_RANGE).toString();
      // Contrast hierarchy: the outer boundary reads strongest.
      const opacity = [0.45, 0.65, 1][index];
      return `<circle cx="${CENTER}" cy="${CENTER}" r="${radius}" class="plot-ring" opacity="${opacity}"/>`
        + `<text x="${CENTER + Number(radius) * 0.72}" y="${CENTER - Number(radius) * 0.72}" class="plot-ring-label">${label}</text>`;
    })
    .join("");
  const blips = tracks
    .map((track) => {
      const state = trackState(track, tick);
      const { x, y } = toXY(track.bearingDeg, track.range);
      const classes = `plot-blip plot-${state}${track.id === selected ? " is-selected" : ""}`;
      // Shape-coding doubles the state signal beyond color: filled circle for
      // confirmed, hollow diamond for tentative, small dot for coasting.
      // Labels anchor away from the mast so clustered contacts fan outward
      // instead of piling text on the same side.
      const leftSide = x < CENTER;
      const anchor = leftSide ? "end" : "start";
      const lx = x + (leftSide ? -10 : 10);
      const fx = (n: number): string => n.toFixed(1);
      const mark = state === "tentative"
        ? `<rect x="${fx(x - 4.5)}" y="${fx(y - 4.5)}" width="9" height="9" class="plot-mark"`
        + ` transform="rotate(45 ${fx(x)} ${fx(y)})"/>`
        : `<circle cx="${fx(x)}" cy="${fx(y)}" r="${state === "confirmed" ? 6 : 4}" class="plot-mark"/>`;
      const halo = track.id === selected
        ? `<circle cx="${fx(x)}" cy="${fx(y)}" r="10" class="plot-halo"/>`
        : "";
      return `<g class="${classes}" data-track="${track.id}" tabindex="0" role="button" aria-label="Select contact ${track.id}, ${state}">`
        + `<title>${track.id} · ${state}</title>`
        + halo
        + mark
        + `<text x="${fx(lx)}" y="${fx(y + 4)}" text-anchor="${anchor}">${track.id}</text></g>`;
    })
    .join("");
  const empty = tracks.length === 0
    ? `<text x="${CENTER}" y="${CENTER - 8}" class="plot-empty">NO CONTACTS IN SECTOR</text>`
    + `<text x="${CENTER}" y="${CENTER + 10}" class="plot-empty-hint">hold S to sweep the mast</text>`
    + `<text x="${CENTER}" y="${CENTER + 26}" class="plot-empty-sub">sector ±${Math.round(HALF_FOV_DEG)}° · ${STATION_VISUAL_RANGE}u · visual only</text>`
    : "";
  return `<svg viewBox="0 0 ${SIZE} ${SIZE}" class="plot-scope" role="img" aria-label="Visual sector plot">`
    + `<defs><radialGradient id="plot-wedge-fill" gradientUnits="userSpaceOnUse"`
    + ` cx="${CENTER}" cy="${CENTER}" r="${RADIUS}">`
    + `<stop offset="0%" stop-color="#35C5D9" stop-opacity="0.16"/>`
    + `<stop offset="100%" stop-color="#35C5D9" stop-opacity="0.03"/>`
    + `</radialGradient></defs>`
    + `<line x1="${CENTER - 16}" y1="${CENTER}" x2="${CENTER + 16}" y2="${CENTER}" class="plot-axis"/>`
    + `<line x1="${CENTER}" y1="${CENTER - 16}" x2="${CENTER}" y2="${CENTER + 16}" class="plot-axis"/>`
    + cardinalMarks()
    + rings
    + `<path d="${wedgePath(look)}" class="plot-wedge" fill="url(#plot-wedge-fill)"/>`
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
