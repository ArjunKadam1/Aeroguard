import { CONTROL_HELP } from "../sim/input";
import type { CameraMode } from "../sim/aircraft";
import { buildCockpitHtml, controlHelpHtml, type InstrumentData } from "./cockpit";

export type FlightHudData = InstrumentData;

export interface FlightHud {
  update(data: FlightHudData): void;
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
  help.innerHTML = controlHelpHtml(CONTROL_HELP);
  root.appendChild(help);

  let data: FlightHudData = { altitude: 0, speed: 0, throttle: 0, pitch: 0, roll: 0, heading: 0 };
  let lastCamera: CameraMode | null = null;
  let lastKey = "";

  function render(): void {
    // The horizon rolls with the aircraft, but the FPV camera is body-locked,
    // so the indicator is pinned to show it relative to the world.
    const rollPinned = getCameraMode() === "fpv";
    element.innerHTML = buildCockpitHtml(data, getCameraMode(), rollPinned);
  }
  render();
  element.addEventListener("click", onCycleCamera);

  return {
    update(next) {
      data = next;
      // Rebuild only when a displayed value actually changes, so the DOM is not
      // rewritten on every animation frame.
      const key = [
        Math.round(data.altitude), Math.round(data.speed), Math.round(data.throttle * 100),
        Math.round((data.pitch * 180) / Math.PI), Math.round((data.roll * 180) / Math.PI),
        Math.round((data.heading * 180) / Math.PI),
      ].join("|");
      const camera = getCameraMode();
      if (key !== lastKey || camera !== lastCamera) {
        lastKey = key;
        lastCamera = camera;
        render();
      }
    },
  };
}