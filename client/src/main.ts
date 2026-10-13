import * as THREE from "three";
import { createApiClient } from "./api/client";
import type { AAR, PublicScenario, StartRequest } from "./api/types";
import {
  applyCamera, applyStationCamera, createAircraft, nextCameraMode, spinRotors, type CameraMode,
} from "./sim/aircraft";
import {
  GRAVITY, altitudeAgl, createFlightState, speedOf, stepFlight,
} from "./sim/flight";
import {
  clearControls, createControlState, isFlightKey, press, readControls, release,
} from "./sim/input";
import { advanceStationHeading, pickContact, type ScreenContact } from "./sim/picking";
import {
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
  type Vec3,
} from "./sim/observation";
import { createSimScene } from "./sim/scene";
import { Spawner } from "./sim/spawner";
import { createThreatView, updateThreatView, THREAT_CRUISE_ALTITUDE, type ThreatView } from "./sim/threats";
import { SessionController, initialSelectedThreatId } from "./state/session";
import { createEventQueue } from "./state/eventQueue";
import { mountActions } from "./ui/actions";
import { mountFlightHud } from "./ui/flightHud";
import { mountHud } from "./ui/hud";
import { mountRadar } from "./ui/radar";
import { mountStartPanel, type OperatorMode, type StartPanel } from "./ui/startPanel";
import { mountStationHelp } from "./ui/stationHelp";

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
  const sceneContainer = document.createElement("div");
  sceneContainer.id = "scene";
  app.appendChild(sceneContainer);
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
    const view = createThreatView(profile);
    sim.scene.add(view.mesh);
    views.set(profile.id, view);
  }

  const airborne = mode === "airborne";
  let selected: string | null = initialSelectedThreatId(
    mode,
    scenario.threats.map((threat) => threat.id),
  );
  const hud = mountHud(app, scenario, airborne ? "scout" : "station");
  hud.setSelected(selected);

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
  // Render-camera forward from the previous frame, for the scout observer.
  let cameraForward: Vec3 = { x: 0, y: 0, z: -1 };

  function buildObserver(): Observer {
    if (!airborne) return stationObserver(stationHeading);
    return scoutObserver(
      { x: flight.position.x, y: flight.position.y, z: flight.position.z },
      cameraForward,
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
    ? mountFlightHud(app, () => cameraMode, () => {
      cameraMode = nextCameraMode(cameraMode);
    })
    : null;

  // The station camera does not move on its own, so the trainee has to know
  // how to pan it and how to release a lock.
  const stationHelp = airborne ? null : mountStationHelp(app);

  // The scout's radar scope: bearing/range blips with no identity. Clicking a
  // blip selects the track; classification still needs the visual sensor.
  const radar = airborne ? mountRadar(app, (id) => selectContact(id)) : null;

  if (airborne && flightHud && radar) {
    // Right rail: keyboard help above the radar scope. Both panels were
    // absolutely positioned top-right and overlapped; stacking them in a
    // column keeps either height change from ever colliding again.
    const rail = document.createElement("div");
    rail.id = "right-rail";
    rail.append(flightHud.help, radar.root);
    app.appendChild(rail);
  }

  function respawn(): void {
    const fresh = createFlightState(0, sim.world.heightAt(0, 0) + 120, 120);
    Object.assign(flight.position, fresh.position);
    Object.assign(flight.velocity, fresh.velocity);
    Object.assign(flight.attitude, fresh.attitude);
    Object.assign(flight.angularVelocity, fresh.angularVelocity);
  }

  let stationHeading = 0;
  let sweeping = false;

  function onKeyDown(event: KeyboardEvent): void {
    if (!airborne) {
      // Station controls: hold S to pan the mast, Esc to release the lock.
      if (event.key === "s" || event.key === "S") {
        sweeping = true;
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
    }
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
    }
  });
  controller.start();

  const actions = mountActions(app, {
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
    // Once locked, the pan hint is redundant noise; restore it on release.
    stationHelp?.classList.toggle("is-hidden", id !== null);
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
  function frame(): void {
    if (finishing) return;
    const nowMs = performance.now();
    // Clamp dt so an alt-tab or a slow first frame cannot tunnel the aircraft
    // through the ground.
    const dt = Math.min((nowMs - lastFrameMs) / 1000, 0.05);
    lastFrameMs = nowMs;
    const elapsedSec = (nowMs - startedAt) / 1000;

    if (airborne) {
      stepFlight(flight, readControls(controls, dt), dt, flightEnv);
      aircraft.position.set(flight.position.x, flight.position.y, flight.position.z);
      aircraft.rotation.set(flight.attitude.x, flight.attitude.y, flight.attitude.z);
      spinRotors(aircraft, elapsedSec);
      // Keep the shadow frustum centred on the aircraft so the tight ortho box
      // always contains what the camera is looking at.
      sim.world.aimSunAt(aircraft.position.x, aircraft.position.y, aircraft.position.z);
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
      const forward = sim.camera.getWorldDirection(new THREE.Vector3());
      cameraForward = { x: forward.x, y: forward.y, z: forward.z };
    } else {
      // Ground station: a fixed mast that pans only while the sweep key is held
      // and locks once the trainee selects a contact.
      stationHeading = advanceStationHeading(stationHeading, sweeping, dt);
      applyStationCamera(sim.camera, { heading: stationHeading, focus: focusPoint }, dt);
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
      radar?.setTracks(
        tracks.filter((t) => t.lastSource !== "visual"),
        SCOUT_RADAR_RANGE,
        sweepIndex,
      );
    }

    spawner.update(elapsedSec);
    for (const view of views.values()) {
      updateThreatView(view, elapsedSec);
      // Cruise above local terrain so contacts clear hills in the new world.
      view.mesh.position.y = sim.world.heightAt(
        view.mesh.position.x,
        view.mesh.position.z,
      ) + THREAT_CRUISE_ALTITUDE + Math.sin(elapsedSec) * 2;
    }
    syncHudThreats();
    hud.setRemaining(scenario.duration_seconds - elapsedSec);
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
    sim.render();
    if (!finishing && elapsedSec >= scenario.duration_seconds) {
      void finish();
      return;
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
