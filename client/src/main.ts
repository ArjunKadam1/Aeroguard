import { createApiClient } from "./api/client";
import type { AAR, PublicScenario, StartRequest } from "./api/types";
import {
  applyCamera, applyStationCamera, createAircraft, nextCameraMode, spinRotors, type CameraMode,
} from "./sim/aircraft";
import {
  GRAVITY, altitudeAgl, createFlightState, forwardVector, speedOf, stepFlight,
} from "./sim/flight";
import {
  clearControls, createControlState, isFlightKey, press, readControls, release,
} from "./sim/input";
import { advanceStationHeading, pickContact, type ScreenContact } from "./sim/picking";
import {
  RADAR_PERIOD_S,
  SCOUT_RADAR_RANGE,
  detectRadar,
  detectVisual,
  falseDetections,
  scoutObserver,
  stationObserver,
  trackPermissions,
  trackState,
  trackTick,
  updateTracks,
  type ContactTruth,
  type Observer,
  type SensorConditions,
  type Track,
} from "./sim/observation";
import { createSimScene } from "./sim/scene";
import { Spawner } from "./sim/spawner";
import { createThreatView, updateThreatView, THREAT_CRUISE_ALTITUDE, type ThreatView } from "./sim/threats";
import { SessionController, initialSelectedThreatId } from "./state/session";
import { createEventQueue } from "./state/eventQueue";
import { createViewModeStore, DEFAULT_VIEW_MODE } from "./state/viewMode";
import { mountActions } from "./ui/actions";
import { mountFlightHud } from "./ui/flightHud";
import { mountHud } from "./ui/hud";
import { mountRadar } from "./ui/radar";
import { mountSensorPlot } from "./ui/sensorPlot";
import { mountSelectedPanel, type SelectedContact } from "./ui/selectedPanel";
import { mountStartPanel, type OperatorMode, type StartPanel } from "./ui/startPanel";
import { mountStationHelp } from "./ui/stationHelp";
import { mountViewBar } from "./ui/viewBar";

const api = createApiClient();
const app = document.getElementById("app")!;

function clear(): void {
  app.innerHTML = "";
}

const startPanelRef: { current: StartPanel | null } = { current: null };

function showSetup(): void {
  clear();
  startPanelRef.current = mountStartPanel(
    app,
    (request, traineeId, unit, mode) => { void runSession(request, traineeId, unit, mode); },
    (traineeId, unit) => {
      // Lazily imported: the dashboard is not on the critical path to a session.
      void import("./ui/dashboard").then(({ showDashboard }) => {
        showDashboard(app, api, traineeId, unit, () => { clear(); showSetup(); });
      });
    },
    () => api.listScriptedScenarios(),
  );
}

showSetup();

async function runSession(
  request: StartRequest,
  traineeId: string,
  unit: string | null = null,
  mode: OperatorMode = "station",
): Promise<void> {
  // Surface failures instead of rejecting into an unhandled promise: an
  // infeasible configuration (night at too low a difficulty) returns 422, and
  // silently doing nothing looks like the app is broken.
  startPanelRef.current?.beginLoading();
  try {
    const scenario = request.source === "scripted"
      ? await api.createScriptedScenario(request.scenarioKey)
      : await api.generateScenario(request.generate);
    const session = await api.createSession({
      trainee_id: traineeId,
      scenario_id: scenario.scenario_id,
      unit,
    });
    // Gameplay runs on the redacted view only. The full scenario (with
    // classification labels and expected responses) is never retained in the
    // client beyond this point.
    const view = await api.fetchScenarioView(scenario.scenario_id);
    startPanelRef.current?.endLoading();
    clear();
    startPanelRef.current = null;
    startPlay(view, session.session_id, traineeId, unit, mode);
  } catch (error) {
    startPanelRef.current?.showError(errorMessage(error));
    startPanelRef.current?.endLoading();
  }
}

function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  // The API reports an unreachable difficulty as 422 with a readable detail.
  if (raw.includes("422")) {
    return "That configuration is not reachable. Raise the difficulty, lower the threat count, "
      + "or switch to day. Night adds +2 to the difficulty floor.";
  }
  return `Could not start the scenario: ${raw}`;
}

function startPlay(
  scenario: PublicScenario, sessionId: string, traineeId: string, unit: string | null,
  mode: OperatorMode,
): void {
  const topbar = document.createElement("div");
  topbar.id = "topbar";
  topbar.innerHTML = `
    <div class="topbar-brand"><h1>AUROGUARD</h1><span class="start-badge">TRAINING</span></div>
    <div class="topbar-meta"><b>${scenario.scenario_id}</b> &middot; ${scenario.environment} / ${scenario.time_of_day}`
    + ` &middot; difficulty ${scenario.difficulty} &middot; ${mode === "airborne" ? "airborne" : "ground station"}</div>
    <div class="spacer"></div>
    <span class="topbar-status"></span>
    <span class="topbar-viewbar"></span>`;
  app.appendChild(topbar);

  const workbench = document.createElement("div");
  workbench.id = "workbench";
  workbench.innerHTML = `<div id="panel-left"></div><div id="viewport"></div><div id="panel-right"></div>`;
  app.appendChild(workbench);
  const panelLeft = workbench.querySelector<HTMLElement>("#panel-left")!;
  const viewport = workbench.querySelector<HTMLElement>("#viewport")!;
  const panelRight = workbench.querySelector<HTMLElement>("#panel-right")!;

  const actionbar = document.createElement("div");
  actionbar.id = "actionbar";
  app.appendChild(actionbar);

  const sceneContainer = document.createElement("div");
  sceneContainer.id = "scene";
  // Positioned inline, not just via stylesheet: if a stale stylesheet is ever
  // in play, the canvas container must still fill the viewport, otherwise the
  // container collapses and the canvas can never be fitted to it.
  sceneContainer.style.position = "absolute";
  sceneContainer.style.inset = "0";
  viewport.appendChild(sceneContainer);
  const sim = createSimScene(sceneContainer, scenario);

  const startedAt = performance.now();
  const now = () => Math.round(performance.now() - startedAt);

  // Event submission failures are assigned to the action notice once actions
  // exist. A dropped event can change the score, so console-only reporting is
  // not sufficient.
  let reportEventError: (message: string) => void = () => {};
  const queue = createEventQueue(
    (nextEvent) => api.submitEvent(sessionId, nextEvent),
    (error) => {
      console.error("event submission failed", error);
      reportEventError("Event save failed. The score may be incomplete.");
    },
  );
  const controller = new SessionController(scenario, sessionId, traineeId, {
    emit: (nextEvent) => queue.emit(nextEvent),
    now,
  });

  const views = new Map<string, ThreatView>();
  for (const profile of scenario.threats) {
    const view = createThreatView(profile, scenario.seed);
    sim.scene.add(view.mesh);
    views.set(profile.id, view);
  }

  const airborne = mode === "airborne";
  let selected: string | null = initialSelectedThreatId(
    mode,
    scenario.threats.map((threat) => threat.id),
  );
  const hud = mountHud(panelLeft, scenario, airborne ? "scout" : "station", (id) => selectContact(id));
  hud.setSelected(selected);
  const selectedPanel = mountSelectedPanel(panelRight);
  selectedPanel.set(null);

  // Sensor conditions never change mid-session; the observation model reads
  // them, and the HUD states them, so degraded sensing is always explained.
  const conditions: SensorConditions = {
    sensorQuality: scenario.sensor_quality,
    night: scenario.time_of_day === "night",
    visibility: scenario.visibility,
  };

  // Unified sensor tracks (both modes), refreshed on fixed time quanta so
  // observation never depends on frame rate.
  let tracks: Track[] = [];
  let lastTrackTick = -1;
  // First-seen timestamps per track, for the AAR's observable-vs-action view:
  // when the contact entered the sensor picture vs when the trainee acted.
  const firstSeen = new Map<string, number>();

  function buildObserver(): Observer {
    if (!airborne) return stationObserver(stationHeading);
    // Nose-mounted sensor: the look direction comes from the authoritative
    // flight attitude, never from a display camera. FPV looks along exactly
    // this vector, so FPV sensing is unchanged; chase/gimbal views no longer
    // steer the sensor. Stepping the sim therefore needs no rendered camera.
    return scoutObserver(
      { x: flight.position.x, y: flight.position.y, z: flight.position.z },
      forwardVector(flight.attitude),
    );
  }

  function visibleTruths(): ContactTruth[] {
    const truths: ContactTruth[] = [];
    for (const [id, view] of views) {
      if (!view.mesh.visible) continue;
      const position = view.mesh.position;
      truths.push({
        id,
        position: { x: position.x, y: position.y, z: position.z },
        spawned: true,
      });
    }
    return truths;
  }

  /** Sensor permissions for the selected contact, from its track (if any). */
  function selectedSensing(): { detect: boolean; classify: boolean; sensor: "visual" | "radar" } {
    const track = selected ? tracks.find((t) => t.id === selected) : undefined;
    const permissions = trackPermissions(track ?? null);
    return {
      ...permissions,
      sensor: track && track.seenVisual ? "visual" : "radar",
    };
  }

  // --- Flight (airborne mode only) --------------------------------------
  // The training loop (detect/classify/respond, event log, scoring) is
  // unchanged and always owned by SessionController. In ground-station mode the
  // trainee observes rather than flies, matching the problem statement; both
  // modes produce identical scored events.
  const aircraft = createAircraft();
  if (airborne) sim.scene.add(aircraft);

  const flightEnv = {
    groundAt: (x: number, z: number) => sim.world.heightAt(x, z),
    gravity: GRAVITY,
  };
  const flight = createFlightState(0, sim.world.heightAt(0, 0) + 120, 120);
  const controls = createControlState(0.55);
  let cameraMode: CameraMode = "fpv";
  // The flight HUD is an airborne instrument; showing it on the ground station
  // would imply piloting that the mode does not offer.
  const flightHud = airborne
    ? mountFlightHud(viewport, () => cameraMode, () => {
      cameraMode = nextCameraMode(cameraMode);
    })
    : null;

  // The station camera does not move on its own, so the trainee has to know
  // how to pan it and how to release a lock.
  const stationHelp = airborne ? null : mountStationHelp(viewport);

  // The scout's radar scope: bearing/range blips with no identity. Clicking a
  // blip selects the track; classification still needs the visual sensor.
  const radar = airborne ? mountRadar(viewport, (id) => selectContact(id)) : null;

  // Right rails (world-view layout): flight help above the radar scope, so
  // neither panel can overlap the other.
  let airborneRail: HTMLElement | null = null;
  if (airborne && flightHud && radar) {
    // Right rail: keyboard help above the radar scope. Both panels were
    // absolutely positioned top-right and overlapped; stacking them in a
    // column keeps either height change from ever colliding again.
    airborneRail = document.createElement("div");
    airborneRail.id = "right-rail";
    airborneRail.append(flightHud.help, radar.root);
    viewport.appendChild(airborneRail);
  }

  // View modes: 2D Sensors is the default working view, 3D World keeps the
  // spatial scene, Split shows both side by side. Switching only shows/hides
  // views and skips the 3D draw -- the scenario, clock, tracks, selection, and events are untouched, so the
  // session continues identically in either view. The ground station's 2D
  // view is the sector plot; the scout's is its radar scope (already a 2D
  // sensor display, now also the default).
  const viewStore = createViewModeStore(DEFAULT_VIEW_MODE);
  const viewBar = mountViewBar(topbar.querySelector<HTMLElement>(".topbar-viewbar")!, (mode) => viewStore.set(mode));
  const plot = airborne ? null : mountSensorPlot(viewport, (id) => selectContact(id));
  // Center stage for the 2D sensor view: the sector plot (station) or radar
  // scope (scout) moves here large and centred; the rails keep the help and
  // instrument panels. Moving nodes preserves their listeners and state.
  const stage = document.createElement("div");
  stage.id = "sensor-stage";
  viewport.appendChild(stage);
  // Assigned by the station rail block below; applyView first runs after it.
  let stationRail: HTMLElement | null = null;
  function applyView(): void {
    const mode = viewStore.get();
    // Sensors view hides the scene; world and split both draw it.
    sceneContainer.classList.toggle("is-hidden", mode === "sensors");
    // World view hides the sensor stage; sensors and split both show it
    // (centred overlay vs docked side panel, via CSS).
    stage.classList.toggle("is-hidden", mode === "world");
    app.classList.toggle("view-split", mode === "split");
    app.classList.toggle("view-sensors", mode === "sensors");
    // Split narrows the scene container: refit the canvas to it (a no-op
    // while hidden, where the size reads 0 and no draw happens).
    sim.resize();
    if (mode === "world") {
      // 3D World: sensor panels dock back into their right rails.
      if (stationRail && stationHelp && plot) stationRail.append(stationHelp, plot.root);
      if (airborneRail && flightHud && radar) airborneRail.append(flightHud.help, radar.root);
      plot?.root.classList.toggle("is-hidden", true);
    } else {
      // 2D Sensors and Split: the plot/scope lives on the sensor stage.
      if (plot) {
        stage.append(plot.root);
        plot.root.classList.toggle("is-hidden", false);
      }
      if (radar) stage.append(radar.root);
    }
    viewBar.set(mode);
  }
  viewStore.subscribe(applyView);

  if (!airborne && stationHelp && plot) {
    // Right rail (station): control hints above the sector plot, mirroring
    // the airborne rail so neither panel can overlap the other.
    stationRail = document.createElement("div");
    stationRail.id = "right-rail";
    stationRail.append(stationHelp, plot.root);
    viewport.appendChild(stationRail);
  }
  applyView();

  function respawn(): void {
    const fresh = createFlightState(0, sim.world.heightAt(0, 0) + 120, 120);
    Object.assign(flight.position, fresh.position);
    Object.assign(flight.velocity, fresh.velocity);
    Object.assign(flight.attitude, fresh.attitude);
    Object.assign(flight.angularVelocity, fresh.angularVelocity);
  }

  let stationHeading = 0;
  let sweeping = false;
  // Sweep direction follows the key combination: S pans one way around the
  // full circle, Shift+S the other. Read live on every key repeat so picking
  // up or releasing Shift mid-sweep reverses immediately.
  let sweepDir: 1 | -1 = -1;

  function onKeyDown(event: KeyboardEvent): void {
    if (!airborne) {
      // Station controls: hold S to sweep the mast, Esc to release the lock.
      if (event.key === "s" || event.key === "S") {
        sweeping = true;
        sweepDir = event.shiftKey ? 1 : -1;
        event.preventDefault();
        return;
      }
      if (event.key === "Escape") {
        deselect();
        event.preventDefault();
        return;
      }
      return;
    }
    if (event.key === "c" || event.key === "C") {
      cameraMode = nextCameraMode(cameraMode);
      return;
    }
    if (event.key === "Backspace") {
      event.preventDefault();
      respawn();
      return;
    }
    if (isFlightKey(event.key)) event.preventDefault();
    press(controls, event.key);
  }
  function onKeyUp(event: KeyboardEvent): void {
    if (!airborne) {
      if (event.key === "s" || event.key === "S") sweeping = false;
      return;
    }
    release(controls, event.key);
  }
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", () => clearControls(controls));

  // Push per-threat stage changes (spawn/detect/classify/respond) into the HUD.
  // Only spawned-and-later contacts are shown: pending contacts are not
  // observations yet, and listing them would leak future spawn knowledge.
  // Each row also carries its track lifecycle state, so tentative/coasting
  // contacts read as less certain than confirmed ones.
  let hudStageKey = "";
  function syncHudThreats(): void {
    const states = controller.threats
      .filter((t) => t.stage !== "pending")
      .map((t) => {
        const track = tracks.find((candidate) => candidate.id === t.profile.id);
        return {
          id: t.profile.id,
          stage: t.stage,
          behavior: t.profile.behavior,
          track: track ? trackState(track, lastTrackTick) : "unseen",
        };
      });
    const key = states.map((s) => `${s.id}:${s.stage}:${s.track}`).join("|");
    if (key !== hudStageKey) {
      hudStageKey = key;
      hud.setThreats(states);
      const current = controller.threats.find((t) => t.profile.id === selected);
      actions.setStage(current?.stage ?? "pending");
      selectedPanel.set(selectedInfo());
    }
  }

  const statusEl = topbar.querySelector<HTMLElement>(".topbar-status")!;
  let statusKey = "";
  function syncTopStatus(elapsedSec: number): void {
    const observed = controller.threats.filter((t) => t.stage !== "pending").length;
    const left = Math.max(0, Math.ceil(scenario.duration_seconds - elapsedSec));
    const key = `${left}|${observed}|${finishing}`;
    if (key === statusKey) return;
    statusKey = key;
    statusEl.innerHTML = `T-${left}s &middot; <b>${observed}</b> observed &middot; ${finishing ? "complete" : "live"}`;
  }

  const spawner = new Spawner(scenario, (id) => {
    controller.spawnThreat(id);
    // Airborne auto-selects a new contact because you want to act on what just
    // flew past. The ground station must NOT: auto-lock hands the trainee the
    // search that the "recognize" objective is measuring.
    if (airborne) {
      selected = id;
      hud.setSelected(id);
      hudStageKey = "";
      selectedPanel.set(selectedInfo());
    }
  });
  controller.start();

  const actions = mountActions(actionbar, {
onDetect: () => {
      if (!selected) return flashNotice("Select a threat first.");
      // Detection is an observation: some sensor track must hold the contact.
      const sensing = selectedSensing();
      if (!sensing.detect) return flashNotice("No sensor holds this contact.");
      // A tracked contact with no scenario threat is a false contact: calling
      // it in is the false alarm the penalty path exists for. Scoring
      // denominators never see it; only the −5 penalty applies.
      const known = controller.threats.some((t) => t.profile.id === selected);
      if (!known) {
        controller.falseAlarm();
        return flashNotice("False contact — false alarm recorded (−5).");
      }
      const view = views.get(selected);
      if (!view || !view.mesh.visible) {
        return flashNotice("No observable contact selected.");
      }
      const provenance: Record<string, unknown> = { observer: mode, sensor: sensing.sensor };
      const seenAt = firstSeen.get(selected);
      if (seenAt !== undefined) provenance.first_seen_ms = seenAt;
      if (!controller.detect(selected, provenance)) {
        flashNotice("Already detected.");
      }
    },
    onClassify: (label) => {
      if (!selected) return flashNotice("Select a threat first.");
      // Radar reports existence and position, never identity: classification
      // needs a track the visual sensor has confirmed.
      const sensing = selectedSensing();
      if (!sensing.classify) {
        return flashNotice("Classification needs a visual contact — aim the camera at it.");
      }
      if (!controller.classify(selected, label, { observer: mode, sensor: sensing.sensor })) {
        flashNotice("Detect the threat before classifying.");
      }
    },
    onRespond: (response) => {
      if (!selected) return flashNotice("Select a threat first.");
      const sensing = selectedSensing();
      if (!controller.respond(selected, response, { observer: mode, sensor: sensing.sensor })) {
        flashNotice("Classify the threat before responding.");
      }
    },
    onFalseAlarm: () => controller.falseAlarm(),
    onFinish: () => finish(),
  });
  reportEventError = (message) => actions.setNotice(message);

  let noticeTimer = 0;
  function flashNotice(message: string): void {
    actions.setNotice(message);
    window.clearTimeout(noticeTimer);
    noticeTimer = window.setTimeout(() => actions.setNotice(""), 2000);
  }

  // Click a contact to select it. Selection is done in screen space rather than
  // with a raycast: contacts are Groups, and intersectObjects(meshes, false)
  // cannot descend into a Group, so the raycast silently never hit anything.
  // Contacts are also only ~20px across from the station, so nearest-within-
  // tolerance is both correct and practical.
  function selectContact(id: string | null): void {
    selected = id;
    hud.setSelected(id);
    hudStageKey = "";
    selectedPanel.set(selectedInfo());
    // Once locked, the pan hint is redundant noise; restore it on release.
    stationHelp?.classList.toggle("is-hidden", id !== null);
  }

  /** Trainee-visible evidence for the selected contact, or null. */
  function selectedInfo(): SelectedContact | null {
    if (!selected) return null;
    const entry = controller.threats.find((t) => t.profile.id === selected);
    if (!entry) return null;
    const track = tracks.find((t) => t.id === selected);
    const sensing = selectedSensing();
    // Live grid fix from the rendered contact: the same position the trainee
    // sees on screen, rounded so the panel only rewrites on real movement.
    const mesh = views.get(selected);
    const pos = mesh && mesh.mesh.visible
      ? {
        x: Math.round(mesh.mesh.position.x),
        z: Math.round(mesh.mesh.position.z),
        alt: Math.round(mesh.mesh.position.y),
      }
      : null;
    return {
      state: {
        id: entry.profile.id,
        stage: entry.stage,
        behavior: entry.profile.behavior,
        track: track ? trackState(track, lastTrackTick) : "unseen",
      },
      behaviorHint: scenario.cue_legend[entry.profile.behavior] ?? "",
      observer: airborne ? "scout" : "station",
      sensor: sensing.sensor,
      tracked: track !== undefined,
      firstSeenMs: firstSeen.get(selected) ?? null,
      pos,
      speedClass: entry.profile.speed_class,
      flightPattern: entry.profile.flight_pattern,
    };
  }

  sim.renderer.domElement.addEventListener("click", (event) => {
    const rect = sim.renderer.domElement.getBoundingClientRect();
    const clickX = event.clientX - rect.left;
    const clickY = event.clientY - rect.top;
    const projected: ScreenContact[] = [...views.values()].map((view) => {
      const p = view.mesh.position.clone().project(sim.camera);
      return {
        id: view.profile.id,
        x: ((p.x + 1) / 2) * rect.width,
        y: ((1 - p.y) / 2) * rect.height,
        visible: view.mesh.visible && p.z < 1,
      };
    });
    const id = pickContact(projected, clickX, clickY);
    // A miss deselects, so the trainee can release the lock and keep scanning.
    selectContact(id);
  });

  function deselect(): void {
    if (selected) selectContact(null);
  }

  let finishing = false;
  async function finish(): Promise<void> {
    if (finishing) return;
    finishing = true;
    actions.setEnabled(false);
    controller.complete();
    await queue.flush();
    const result = await api.completeSession(sessionId);
    sim.dispose();
    // Tear down the session UI (scene, HUD, actions, sensor panels, view bar)
    // so the review owns the screen. showAar appends without clearing.
    clear();
    // Local review shown immediately; the server AAR replaces it on arrival.
    const fallbackAar: AAR = {
      session_id: sessionId,
      scenario_id: scenario.scenario_id,
      summary: "Reviewing session…",
      scores: {
        session_id: result.session_id,
        detection_score: result.detection_score,
        classification_score: result.classification_score,
        response_score: result.response_score,
        timing_score: result.timing_score,
        penalty: result.penalty,
        final_score: result.final_score,
        scoring_version: result.scoring_version,
      },
      timing: {
        mean_time_to_detection_ms: null,
        mean_detection_to_classification_ms: null,
        mean_classification_to_response_ms: null,
        mean_total_decision_ms: null,
      },
      mistakes: [],
      strengths: [],
      weaknesses: [],
      recommendation: "",
      timeline: controller.events,
      ground_truth: [],
    };
    const { showAar } = await import("./ui/aar");
    showAar(app, api, sessionId, traineeId, scenario, fallbackAar, () => {
      showSetup();
    }, unit);
  }

  let lastFrameMs = performance.now();
  let lastSceneW = 0;
  let lastSceneH = 0;

  /**
   * Advance the authoritative simulation by one frame: flight physics, station
   * mast heading, sensor tracks, scenario spawning, and contact motion.
   * Simulation only — it never positions a camera and never draws, so a
   * future 2D view can step the session without a rendered 3D scene. The
   * per-tick radar panel push below is a tick-rate view write (unchanged
   * cadence); V1 will route view writes per active view.
   */
  function stepSim(dt: number, elapsedSec: number): void {
    if (airborne) {
      stepFlight(flight, readControls(controls, dt), dt, flightEnv);
      aircraft.position.set(flight.position.x, flight.position.y, flight.position.z);
      aircraft.rotation.set(flight.attitude.x, flight.attitude.y, flight.attitude.z);
      spinRotors(aircraft, elapsedSec);
      // Keep the shadow frustum centred on the aircraft so the tight ortho box
      // always contains what the camera is looking at.
      sim.world.aimSunAt(aircraft.position.x, aircraft.position.y, aircraft.position.z);
    } else {
      // Ground station: the mast pans only while the sweep key is held. The
      // heading is simulation state; pointing the camera at it is rendering.
      stationHeading = advanceStationHeading(stationHeading, sweeping, dt, sweepDir);
    }

    // Unified sensor update on fixed time quanta (both modes): raw visual
    // detections every track tick, radar detections on sweep ticks, seeded
    // false radar contacts for the scout, all fused into lifecycle tracks.
    // Fixed quanta keep observation identical across frame rates.
    const trackTickNow = trackTick(elapsedSec);
    if (trackTickNow !== lastTrackTick) {
      lastTrackTick = trackTickNow;
      const observer = buildObserver();
      const truths = visibleTruths();
      const visual = detectVisual(observer, truths, conditions, scenario.seed, trackTickNow);
      const sweepIndex = Math.floor(trackTickNow / 4); // 0.5s ticks, 2s sweeps
      let radarDetections = airborne
        ? detectRadar(observer, truths, conditions, scenario.seed, sweepIndex)
        : [];
      if (airborne) {
        radarDetections = radarDetections.concat(falseDetections(scenario.seed, sweepIndex, conditions));
      }
      tracks = updateTracks(tracks, visual, radarDetections, trackTickNow);
      for (const track of tracks) {
        if (track.lastTick === trackTickNow && !firstSeen.has(track.id)) {
          firstSeen.set(track.id, Math.round(elapsedSec * 1000));
        }
      }
      // Scout 2D view: the scope shows every track, styled by source --
      // radar-held solid, visual-held as rings -- so nothing observable is
      // hidden from the sensor display.
      // New arrivals this sweep get an arrival flash on the scope: tracks
      // first seen since the current sweep began. Purely observational.
      const sweepStartMs = sweepIndex * RADAR_PERIOD_S * 1000;
      const freshIds = tracks
        .filter((t) => (firstSeen.get(t.id) ?? -1) >= sweepStartMs)
        .map((t) => t.id);
      // Live altitude for the selected contact, from its rendered position.
      const altById: Record<string, number> = {};
      if (selected) {
        const selectedView = views.get(selected);
        if (selectedView && selectedView.mesh.visible) {
          altById[selected] = Math.round(selectedView.mesh.position.y);
        }
      }
      radar?.setTracks(tracks, SCOUT_RADAR_RANGE, sweepIndex, selected, freshIds, altById);
      // Station 2D view: the sector plot follows the same tick with the live
      // mast heading, so the wedge shows where the sensor is looking.
      plot?.setTracks(tracks, trackTickNow, stationHeading, selected);
    }

    spawner.update(elapsedSec);
    for (const view of views.values()) {
      updateThreatView(view, elapsedSec);
      // Cruise above local terrain so contacts clear hills in the new world.
      // The trajectory's altitude offset rides on top, clamped to its design
      // band so a pattern can never push a contact through the terrain.
      const altOffset = view.mesh.userData.altOffset as number | undefined;
      const climb = Math.min(45, Math.max(-20, altOffset ?? 0));
      view.mesh.position.y = sim.world.heightAt(
        view.mesh.position.x,
        view.mesh.position.z,
      ) + THREAT_CRUISE_ALTITUDE + climb + Math.sin(elapsedSec) * 2;
    }
  }

  /**
   * Render the current simulation state. The world and split views position
   * the cameras and draw the 3D scene; the sensor view skips the draw (the
   * canvas is hidden) while HUD/radar/plot panels keep syncing, so the
   * session advances identically with no 3D rendering.
   */
  function renderViews(dt: number, elapsedSec: number): void {
    if (viewStore.get() !== "sensors") {
      // Refit the canvas whenever the container size changed: view switches,
      // window resizes, or recovery from a zero-size canvas all funnel here,
      // so a stranded canvas heals on its own within one frame.
      const sceneW = sceneContainer.clientWidth;
      const sceneH = sceneContainer.clientHeight;
      if (sceneW > 0 && sceneH > 0 && (sceneW !== lastSceneW || sceneH !== lastSceneH)) {
        lastSceneW = sceneW;
        lastSceneH = sceneH;
        sim.resize();
      }
      const focusView = selected ? views.get(selected) : undefined;
      const focusPoint = focusView && focusView.mesh.visible
        ? focusView.mesh.position.clone()
        : null;

      if (airborne) {
        // The gimbal is a sensor, not a cheat: it tracks the selected contact
        // only while a sensor track holds it. Otherwise it looks ahead, so an
        // undetected contact cannot be stared at for free.
        const tracked = selected !== null && tracks.some((t) => t.id === selected);
        applyCamera(
          sim.camera,
          cameraMode,
          { state: flight, focus: tracked ? focusPoint : null, elapsedSec },
          dt,
        );
      } else {
        // Ground station: a fixed mast that pans only while the sweep key is held
        // and locks once the trainee selects a contact.
        applyStationCamera(sim.camera, { heading: stationHeading, focus: focusPoint }, dt);
      }
      sim.render();
    }

    syncHudThreats();
    hud.setRemaining(scenario.duration_seconds - elapsedSec);
    syncTopStatus(elapsedSec);
    if (flightHud) {
      flightHud.update({
        altitude: altitudeAgl(flight, flightEnv),
        speed: speedOf(flight),
        throttle: controls.throttle,
        pitch: flight.attitude.x,
        roll: flight.attitude.z,
        heading: flight.attitude.y,
      });
    }
  }

  function frame(): void {
    if (finishing) return;
    const nowMs = performance.now();
    // Clamp dt so an alt-tab or a slow first frame cannot tunnel the aircraft
    // through the ground.
    const dt = Math.min((nowMs - lastFrameMs) / 1000, 0.05);
    lastFrameMs = nowMs;
    const elapsedSec = (nowMs - startedAt) / 1000;

    // Exactly one loop, one state: step the simulation, then draw it.
    stepSim(dt, elapsedSec);
    renderViews(dt, elapsedSec);
    if (!finishing && elapsedSec >= scenario.duration_seconds) {
      void finish();
      return;
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
