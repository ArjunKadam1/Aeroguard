import { CONTROL_HELP } from "../sim/input";
import type { CameraMode } from "../sim/aircraft";

export interface FlightHudData {
  altitude: number;
  speed: number;
  throttle: number;
  pitch: number;
  roll: number;
  heading: number;
}

export interface FlightHud {
  update(data: FlightHudData): void;
}

function compassHeading(radians: number): string {
  // Heading is the yaw angle; convert to a compass bearing in degrees.
  const degrees = (radians * 180) / Math.PI;
  const normalized = ((degrees % 360) + 360) % 360;
  return `${Math.round(normalized).toString().padStart(3, "0")}°`;
}

export function buildFlightHudHtml(data: FlightHudData, cameraMode: CameraMode): string {
  const rollDegrees = Math.round((data.roll * 180) / Math.PI);
  const pitchDegrees = Math.round((data.pitch * 180) / Math.PI);
  const throttlePercent = Math.round(data.throttle * 100);
  const barWidth = Math.round(Math.min(1, data.throttle) * 100);
  return `
    <div class="fhud-row">
      <span class="fhud-cell"><em>ALT</em>${Math.round(data.altitude)}m</span>
      <span class="fhud-cell"><em>SPD</em>${Math.round(data.speed)}</span>
      <span class="fhud-cell"><em>HDG</em>${compassHeading(data.heading)}</span>
      <span class="fhud-cell"><em>CAM</em>${cameraMode.toUpperCase()}</span>
    </div>
    <div class="fhud-row f-hud-attitude">
      <span class="fhud-cell"><em>PITCH</em>${pitchDegrees}&deg;</span>
      <span class="fhud-cell"><em>ROLL</em>${rollDegrees}&deg;</span>
      <span class="fhud-cell f-hud-throttle">
        <em>THR</em>${throttlePercent}%
        <span class="fhud-bar"><span class="fhud-bar-fill" style="width:${barWidth}%"></span></span>
      </span>
    </div>`;
}

export function mountFlightHud(
  root: HTMLElement,
  getCameraMode: () => CameraMode,
  onCycleCamera: () => void,
): FlightHud {
  const element = document.createElement("div");
  element.id = "flight-hud";
  element.className = "panel";
  root.appendChild(element);

  const help = document.createElement("div");
  help.className = "fhud-help panel";
  help.innerHTML = CONTROL_HELP.map(([k, d]) => `<div><kbd>${k}</kbd><span>${d}</span></div>`).join("");
  root.appendChild(help);

  let data: FlightHudData = { altitude: 0, speed: 0, throttle: 0, pitch: 0, roll: 0, heading: 0 };
  let lastCamera: CameraMode | null = null;
  let lastRendered = "";

  function render(): void {
    element.innerHTML = buildFlightHudHtml(data, getCameraMode());
  }
  render();
  element.addEventListener("click", onCycleCamera);

  return {
    update(next) {
      data = next;
      // Rebuilding the whole panel every frame is wasteful; the instruments only
      // need redrawing when a displayed value actually changes.
      const rounded = `${Math.round(data.altitude)}|${Math.round(data.speed)}|${Math.round(data.throttle * 100)}|${Math.round((data.pitch * 180) / Math.PI)}|${Math.round((data.roll * 180) / Math.PI)}|${Math.round((data.heading * 180) / Math.PI)}`;
      const camera = getCameraMode();
      if (rounded !== lastRendered || camera !== lastCamera) {
        lastRendered = rounded;
        lastCamera = camera;
        render();
      }
    },
  };
}