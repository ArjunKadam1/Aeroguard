// Post-session debrief replay: a top-down reconstruction of flown paths with
// decision markers on a scrubbable timeline. Positions come from
// threatPositionAt -- the exact composition the session loop applies -- so the
// replay reproduces flown paths bit-identically from (seed, profile, time).
// Markers come from the recorded event timeline. This mounts only in the
// after-action review, where ground truth is already revealed; it never runs
// during a live session. Starts paused; the loop self-stops if unmounted.

import type { EventCreateRequest, PublicScenario } from "../api/types";
import { RESPONSE_WORKFLOW_KEY } from "../sim/response";
import { threatDotColor } from "./hud";
import { threatPositionAt } from "../sim/threats";
import { buildSwarmIndex, type SwarmIndex } from "../sim/swarm";
import { Terrain } from "../sim/terrain";

export const REPLAY_BOUNDS = { minX: -600, maxX: 600, minZ: -400, maxZ: 400 } as const;
const VIEW_W = REPLAY_BOUNDS.maxX - REPLAY_BOUNDS.minX;
const VIEW_H = REPLAY_BOUNDS.maxZ - REPLAY_BOUNDS.minZ;
/** Path sampling step: fine enough for smooth polylines, cheap to precompute. */
export const REPLAY_SAMPLE_S = 2;

export function replayX(x: number): number {
  return x - REPLAY_BOUNDS.minX;
}

export function replayY(z: number): number {
  // North (-Z) at the top, matching the sensor plots.
  return z - REPLAY_BOUNDS.minZ;
}

export type ReplayMarkerKind = "spawned" | "detected" | "classified" | "responded" | "missed" | "alarm";

export interface ReplayMarker {
  t: number;
  id: string | null;
  kind: ReplayMarkerKind;
  label: string;
}

const MARKER_BY_TYPE: Record<string, { kind: ReplayMarkerKind; label: string }> = {
  THREAT_SPAWNED: { kind: "spawned", label: "Spawned" },
  THREAT_DETECTED: { kind: "detected", label: "Detected" },
  CLASSIFICATION_SUBMITTED: { kind: "classified", label: "Classified" },
  RESPONSE_SUBMITTED: { kind: "responded", label: "Responded" },
  THREAT_MISSED: { kind: "missed", label: "Missed" },
  FALSE_ALARM: { kind: "alarm", label: "False alarm" },
  THREAT_RESOLVED: { kind: "responded", label: "Resolved" },
};

/** Decision markers from the recorded timeline, sorted by session time. */
export function replayEvents(
  timeline: readonly EventCreateRequest[],
  knownIds: ReadonlySet<string>,
): ReplayMarker[] {
  const markers: ReplayMarker[] = [];
  for (const event of timeline) {
    // Simulated-response workflow records ride the RESPONSE_SUBMITTED carrier
    // with a null threat_id: they are workflow history, not scored decisions,
    // and must never appear as decision markers on the replay.
    if (event.payload?.workflow === RESPONSE_WORKFLOW_KEY) continue;
    const mapped = MARKER_BY_TYPE[event.type];
    if (!mapped) continue;
    const id = event.threat_id ?? null;
    // Session-level or unknown-contact events carry no map position.
    if (id !== null && !knownIds.has(id) && mapped.kind !== "alarm") continue;
    markers.push({ t: Math.max(0, event.timestamp_ms / 1000), id, kind: mapped.kind, label: mapped.label });
  }
  markers.sort((a, b) => a.t - b.t);
  return markers;
}

/** Sampled full-session path for one contact (visible fixes only). */
export function replayPath(
  threatId: string,
  scenario: PublicScenario,
  groundAt: (x: number, z: number) => number,
): Array<{ t: number; x: number; y: number }> {
  const profile = scenario.threats.find((t) => t.id === threatId);
  if (!profile) return [];
  const swarmIndex = buildSwarmIndex(scenario.threats);
  const points: Array<{ t: number; x: number; y: number }> = [];
  for (let t = 0; t <= scenario.duration_seconds; t += REPLAY_SAMPLE_S) {
    const p = threatPositionAt(
      profile, scenario.seed, t, groundAt, swarmIndex.get(profile.id),
    );
    if (!p.visible) continue;
    points.push({ t, x: replayX(p.x), y: replayY(p.z) });
  }
  return points;
}

export function buildReplayHtml(duration: number, markers: readonly ReplayMarker[]): string {
  const ticks = markers
    .map((m) => {
      const pct = duration > 0 ? Math.min(100, (m.t / duration) * 100) : 0;
      return `<button type="button" class="rp-tick rp-${m.kind}" style="left:${pct.toFixed(1)}%"`
        + ` data-t="${m.t.toFixed(1)}" title="${m.label}${m.id ? ` ${m.id}` : ""} · ${m.t.toFixed(1)}s"`
        + ` aria-label="Seek to ${m.label}${m.id ? ` ${m.id}` : ""} at ${m.t.toFixed(1)} seconds"></button>`;
    })
    .join("");
  return `<div class="rp-controls">
      <button type="button" class="rp-play" aria-label="Play replay">▶</button>
      <button type="button" class="rp-speed" aria-label="Cycle replay speed">1×</button>
      <span class="rp-time" aria-live="off">0.0s / ${duration.toFixed(0)}s</span>
    </div>
    <div class="rp-track" role="group" aria-label="Decision markers">${ticks || `<span class="rp-none">no recorded decisions</span>`}</div>
    <input type="range" class="rp-scrub" min="0" max="${duration.toFixed(1)}" step="0.5" value="0"`
    + ` aria-label="Scrub replay time" />
    <svg viewBox="0 0 ${VIEW_W} ${VIEW_H}" class="rp-map" role="img" aria-label="Session replay map">`
    + `<rect x="0" y="0" width="${VIEW_W}" height="${VIEW_H}" class="rp-frame"/>`
    + `<text x="${VIEW_W / 2}" y="20" class="rp-north" text-anchor="middle">N</text>`
    + `<g class="rp-paths"></g><g class="rp-dots"></g>`
    + `</svg>
    <div class="rp-foot"><span>TOP-DOWN REPLAY · post-session debrief</span><span>click a marker to seek</span></div>`;
}

export interface ReplayHandle {
  destroy(): void;
}

export function mountReplay(
  root: HTMLElement,
  scenario: PublicScenario,
  timeline: readonly EventCreateRequest[],
): ReplayHandle {
  const knownIds = new Set(scenario.threats.map((t) => t.id));
  const markers = replayEvents(timeline, knownIds);
  const duration = scenario.duration_seconds;
  root.innerHTML = buildReplayHtml(duration, markers);

  const terrain = new Terrain({ seed: scenario.seed, environment: scenario.environment });
  const groundAt = (x: number, z: number): number => terrain.heightAt(x, z);
  const swarmIndex: SwarmIndex = buildSwarmIndex(scenario.threats);
  const pathsLayer = root.querySelector<SVGGElement>(".rp-paths")!;
  const dotsLayer = root.querySelector<SVGGElement>(".rp-dots")!;
  const playButton = root.querySelector<HTMLButtonElement>(".rp-play")!;
  const speedButton = root.querySelector<HTMLButtonElement>(".rp-speed")!;
  const timeLabel = root.querySelector<HTMLElement>(".rp-time")!;
  const scrub = root.querySelector<HTMLInputElement>(".rp-scrub")!;

  const NS = "http://www.w3.org/2000/svg";
  const dots = new Map<string, SVGCircleElement>();
  for (const profile of scenario.threats) {
    const pts = replayPath(profile.id, scenario, groundAt);
    if (pts.length > 0) {
      const poly = document.createElementNS(NS, "polyline");
      poly.setAttribute("points", pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" "));
      poly.setAttribute("class", "rp-path");
      poly.setAttribute("style", `stroke:${threatDotColor(profile.id)}`);
      pathsLayer.appendChild(poly);
    }
    const dot = document.createElementNS(NS, "circle");
    dot.setAttribute("r", "7");
    dot.setAttribute("class", "rp-dot");
    dot.setAttribute("style", `fill:${threatDotColor(profile.id)}`);
    const title = document.createElementNS(NS, "title");
    title.textContent = profile.id;
    dot.appendChild(title);
    dotsLayer.appendChild(dot);
    dots.set(profile.id, dot);
  }

  let t = 0;
  let playing = false;
  let speed = 1;
  let raf = 0;
  let lastMs = 0;
  let alive = true;

  function paint(): void {
    for (const profile of scenario.threats) {
      const dot = dots.get(profile.id)!;
      const p = threatPositionAt(
        profile, scenario.seed, t, groundAt, swarmIndex.get(profile.id),
      );
      if (!p.visible) {
        dot.setAttribute("visibility", "hidden");
        continue;
      }
      dot.setAttribute("visibility", "visible");
      dot.setAttribute("cx", replayX(p.x).toFixed(1));
      dot.setAttribute("cy", replayY(p.z).toFixed(1));
    }
    timeLabel.textContent = `${t.toFixed(1)}s / ${duration.toFixed(0)}s`;
    if (playing) scrub.value = String(Math.min(t, duration));
  }

  function frame(nowMs: number): void {
    if (!alive || !root.isConnected) return;
    if (playing) {
      const dt = lastMs === 0 ? 0 : (nowMs - lastMs) / 1000;
      lastMs = nowMs;
      t = Math.min(duration, t + dt * speed);
      if (t >= duration) setPlaying(false);
      paint();
    }
    raf = requestAnimationFrame(frame);
  }

  function setPlaying(value: boolean): void {
    if (value && t >= duration) t = 0;
    playing = value;
    lastMs = 0;
    playButton.textContent = playing ? "⏸" : "▶";
    playButton.setAttribute("aria-label", playing ? "Pause replay" : "Play replay");
    paint();
  }

  playButton.addEventListener("click", () => setPlaying(!playing));
  speedButton.addEventListener("click", () => {
    speed = speed === 1 ? 2 : speed === 2 ? 4 : 1;
    speedButton.textContent = `${speed}×`;
  });
  scrub.addEventListener("input", () => {
    t = Math.min(duration, Number(scrub.value) || 0);
    paint();
  });
  root.querySelectorAll<HTMLButtonElement>(".rp-tick").forEach((tick) => {
    tick.addEventListener("click", () => {
      t = Math.min(duration, Number(tick.dataset.t) || 0);
      paint();
    });
  });

  paint();
  raf = requestAnimationFrame(frame);
  return {
    destroy: () => {
      alive = false;
      cancelAnimationFrame(raf);
    },
  };
}
