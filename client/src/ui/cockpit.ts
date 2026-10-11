// Pure render builders for the cockpit instruments. Kept free of DOM and
// Three.js so they can be unit-tested under the node test environment, matching
// the pattern used by hud.ts and aarView.ts.

export type CameraModeName = "fpv" | "chase" | "gimbal";

export interface InstrumentData {
  altitude: number;
  speed: number;
  throttle: number;
  pitch: number;
  roll: number;
  heading: number;
}

export const MAX_ROLL_RADIANS = 1.396;

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

// Artificial horizon as pure SVG. The horizon line rotates by roll and slides
// vertically by pitch, which is how a real attitude indicator behaves.
export function attitudeIndicatorSvg(
  pitch: number,
  roll: number,
  size = 120,
): string {
  const radius = size / 2;
  const pixelsPerDegree = radius / 45;
  const pitchDegrees = (pitch * 180) / Math.PI;
  const rollDegrees = (roll * 180) / Math.PI;
  const offset = clamp(pitchDegrees * pixelsPerDegree, -radius, radius);
  const r = radius - 6;

  // Pitch ladder marks every 10 degrees, both directions.
  const ladder: string[] = [];
  for (let deg = -60; deg <= 60; deg += 10) {
    if (deg === 0) continue;
    const y = radius - deg * pixelsPerDegree + offset;
    if (y < 8 || y > size - 8) continue;
    const half = deg % 20 === 0 ? 18 : 9;
    ladder.push(
      `<line x1="${radius - half}" y1="${y.toFixed(1)}" x2="${radius + half}" y2="${y.toFixed(1)}" />`,
    );
  }

  return `<svg class="adi" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}"
       role="img" aria-label="attitude indicator, pitch ${pitchDegrees.toFixed(0)} degrees, roll ${rollDegrees.toFixed(0)} degrees">
    <defs><clipPath id="adi-clip"><circle cx="${radius}" cy="${radius}" r="${r}"/></clipPath></defs>
    <g clip-path="url(#adi-clip)">
      <g transform="rotate(${(-rollDegrees).toFixed(2)} ${radius} ${radius})">
        <rect x="0" y="${offset.toFixed(1)}" width="${size}" height="${size}" fill="#2f6fb0"/>
        <rect x="0" y="${(offset + radius).toFixed(1)}" width="${size}" height="${size}" fill="#6b4a2a"/>
        <line x1="0" y1="${(offset + radius).toFixed(1)}" x2="${size}" y2="${(offset + radius).toFixed(1)}"
              stroke="#e6edf3" stroke-width="2"/>
        <g stroke="#e6edf3" stroke-width="1" opacity="0.8">${ladder.join("")}</g>
      </g>
    </g>
    <circle cx="${radius}" cy="${radius}" r="${r}" fill="none" stroke="#2a3b4d" stroke-width="2"/>
    <path d="M ${radius - 22} ${radius} L ${radius - 8} ${radius} L ${radius - 8} ${radius + 6}
             L ${radius + 8} ${radius + 6} L ${radius + 8} ${radius} L ${radius + 22} ${radius}"
          fill="none" stroke="#f0b429" stroke-width="2.5"/>
  </svg>`;
}

// Sliding compass tape. Returns the marks near the current heading.
export function headingTapeMarks(heading: number, span = 60, step = 10): string {
  const normalized = ((heading * 180) / Math.PI % 360 + 360) % 360;
  const marks: string[] = [];
  const base = Math.round(normalized / step) * step;
  for (let delta = -span; delta <= span; delta += step) {
    const deg = base + delta;
    const display = ((deg % 360) + 360) % 360;
    const card = { 0: "N", 90: "E", 180: "S", 270: "W" }[display];
    marks.push(
      `<span class="ht-mark" style="left:${50 + delta}%">`
      + `<i>${card ?? display}</i></span>`,
    );
  }
  return marks.join("");
}

export function verticalTape(value: number, label: string, unit = "m"): string {
  const rounded = Math.round(value);
  return `<div class="vtape">
    <span class="vtape-label">${label}</span>
    <span class="vtape-value">${rounded}</span>
    <span class="vtape-unit">${unit}</span>
  </div>`;
}

export function throttleBar(throttle: number): string {
  const pct = Math.round(clamp(throttle, 0, 1) * 100);
  return `<span class="fhud-bar"><span class="fhud-bar-fill" style="width:${pct}%"></span></span>`;
}

export function buildCockpitHtml(
  data: InstrumentData,
  cameraMode: CameraModeName,
  rollPinned: boolean,
): string {
  const headingDeg = ((data.heading * 180) / Math.PI % 360 + 360) % 360;
  return `
    <div class="cockpit">
      ${verticalTape(data.altitude, "ALT")}
      <div class="cockpit-mid">
        <div class="adi-wrap">${attitudeIndicatorSvg(data.pitch, data.roll)}
          ${rollPinned ? '<span class="adi-pin">FPV</span>' : ""}
        </div>
        <div class="htape">
          <span class="htape-read">${Math.round(headingDeg).toString().padStart(3, "0")}&deg;</span>
          ${headingTapeMarks(data.heading)}
        </div>
      </div>
      ${verticalTape(data.speed, "SPD", "m/s")}
    </div>
    <div class="cockpit-sub">
      <span>CAM <b>${cameraMode.toUpperCase()}</b></span>
      <span>THR <b>${Math.round(data.throttle * 100)}%</b></span>
    </div>`;
}

export function controlHelpHtml(help: ReadonlyArray<[string, string]>): string {
  return help.map(([k, d]) => `<div><kbd>${k}</kbd><span>${d}</span></div>`).join("");
}