// Control hints for ground-station mode. The station camera is stationary by
// design, so the trainee must be told how to pan it and release a lock --
// otherwise a still camera reads as a broken one.
const STATION_HELP: ReadonlyArray<[string, string]> = [
  ["Click contact", "select and lock"],
  ["Esc / empty sky", "release lock"],
  ["Hold S", "pan mast"],
  ["Shift + S", "pan mast reverse"],
];

export function buildStationHelpHtml(help = STATION_HELP): string {
  return help.map(([key, action]) =>
    `<div><kbd>${key}</kbd><span>${action}</span></div>`).join("");
}

export function mountStationHelp(root: HTMLElement): HTMLElement {
  const element = document.createElement("div");
  element.id = "station-help";
  element.className = "panel";
  element.innerHTML = `
    <span class="fhud-help-title">GROUND STATION</span>
    ${buildStationHelpHtml()}`;
  root.appendChild(element);
  return element;
}