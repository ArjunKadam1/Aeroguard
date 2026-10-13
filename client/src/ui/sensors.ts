// Sensor status: what each observer can sense and why it is degraded.
// Rendered inside the HUD panel (conditions never change mid-session). The
// point is explainability -- a trainee who loses contacts to night or a weak
// sensor should see the reason stated, not guess at it.
import type { SensorConditions } from "../sim/observation";

export interface SensorSpec {
  visualRange: number;
  radarRange: number;
  radarPeriod: number;
}

export function buildSensorStatusHtml(
  observer: "station" | "scout",
  spec: SensorSpec,
  conditions: SensorConditions,
): string {
  const reasons: string[] = [];
  if (conditions.night) reasons.push("night reduces visual range effectiveness");
  if (conditions.visibility !== "clear") {
    reasons.push(`${conditions.visibility} visibility degrades the visual sensor`);
  }
  if (conditions.sensorQuality < 0.7) {
    reasons.push(`sensor quality ${conditions.sensorQuality.toFixed(2)} weakens radar returns`);
  }
  const reasonLine = reasons.length > 0 ? reasons.join("; ") : "sensors nominal";
  const radarLine = spec.radarRange > 0
    ? `<div><span>Radar</span><span>${spec.radarRange}u · sweep every ${spec.radarPeriod}s · blips only, no identity</span></div>`
    : `<div><span>Radar</span><span>not fitted — visual sensor only</span></div>`;
  return `<div class="hud-sensors"><span class="hud-legend-title">SENSORS · ${observer.toUpperCase()}</span>`
    + `<div><span>Visual</span><span>${spec.visualRange}u · aim to observe</span></div>`
    + radarLine
    + `<div class="sensor-reasons">${reasonLine}</div></div>`;
}
