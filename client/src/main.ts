import * as THREE from "three";
import { createApiClient } from "./api/client";
import type { AAR, Scenario } from "./api/types";
import {
  applyCamera, createAircraft, nextCameraMode, spinRotors, type CameraMode,
} from "./sim/aircraft";
import {
  GRAVITY, altitudeAgl, createFlightState, speedOf, stepFlight,
} from "./sim/flight";
import {
  clearControls, createControlState, isFlightKey, press, readControls, release,
} from "./sim/input";
import { createSimScene } from "./sim/scene";
import { Spawner } from "./sim/spawner";
import { createThreatView, updateThreatView, THREAT_CRUISE_ALTITUDE, type ThreatView } from "./sim/threats";
import { SessionController } from "./state/session";
import { mountActions } from "./ui/actions";
import { mountFlightHud } from "./ui/flightHud";
import { mountHud } from "./ui/hud";
import { mountStartPanel, type StartPanel } from "./ui/startPanel";

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
    (request, traineeId, unit) => { void runSession(request, traineeId, unit); },
    (traineeId, unit) => {
      // Lazily imported: the dashboard is not on the critical path to a session.
      void import("./ui/dashboard").then(({ showDashboard }) => {
        showDashboard(app, api, traineeId, unit, () => { clear(); showSetup(); });
      });
    },
  );
}

showSetup();

async function runSession(
  request: Parameters<typeof api.generateScenario>[0],
  traineeId: string,
  unit: string | null = null,
): Promise<void> {
  // Surface failures instead of rejecting into an unhandled promise: an
  // infeasible configuration (night at too low a difficulty) returns 422, and
  // silently doing nothing looks like the app is broken.
  startPanelRef.current?.beginLoading();
  try {
    const scenario = await api.generateScenario(request);
    const session = await api.createSession({
      trainee_id: traineeId,
      scenario_id: scenario.scenario_id,
      unit,
    });
    startPanelRef.current?.endLoading();
    clear();
    startPanelRef.current = null;
    startPlay(scenario, session.session_id, traineeId, unit);
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
  scenario: Scenario, sessionId: string, traineeId: string, unit: string | null,
): void {
  const sceneContainer = document.createElement("div");
  sceneContainer.id = "scene";
  app.appendChild(sceneContainer);
  const sim = createSimScene(sceneContainer, scenario);

  const startedAt = performance.now();
  const now = () => Math.round(performance.now() - startedAt);

  // Serialize event submission so SESSION_COMPLETED lands before /complete.
  let chain: Promise<unknown> = Promise.resolve();
  const emit = (event: Parameters<typeof api.submitEvent>[1]) => {
    chain = chain.then(() => api.submitEvent(sessionId, event)).catch((error) => {
      console.error("event submission failed", error);
    });
  };
  const controller = new SessionController(scenario, sessionId, traineeId, { emit, now });

  const views = new Map<string, ThreatView>();
  for (const profile of scenario.threats) {
    const view = createThreatView(profile);
    sim.scene.add(view.mesh);
    views.set(profile.id, view);
  }

  let selected: string | null = scenario.threats[0]?.id ?? null;
  const hud = mountHud(app, scenario);

  // --- Flight ----------------------------------------------------------
  // The trainee flies the aircraft; the training loop (detect/classify/respond,
  // event log, scoring) is unchanged and still owned by SessionController.
  const aircraft = createAircraft();
  sim.scene.add(aircraft);

  const flightEnv = {
    groundAt: (x: number, z: number) => sim.world.heightAt(x, z),
    gravity: GRAVITY,
  };
  const flight = createFlightState(0, sim.world.heightAt(0, 0) + 120, 120);
  const controls = createControlState(0.55);
  let cameraMode: CameraMode = "fpv";
  const flightHud = mountFlightHud(app, () => cameraMode, () => {
    cameraMode = nextCameraMode(cameraMode);
  });

  function respawn(): void {
    const fresh = createFlightState(0, sim.world.heightAt(0, 0) + 120, 120);
    Object.assign(flight.position, fresh.position);
    Object.assign(flight.velocity, fresh.velocity);
    Object.assign(flight.attitude, fresh.attitude);
    Object.assign(flight.angularVelocity, fresh.angularVelocity);
  }

  function onKeyDown(event: KeyboardEvent): void {
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
    release(controls, event.key);
  }
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", () => clearControls(controls));

  // Push per-threat stage changes (spawn/detect/classify/respond) into the HUD.
  let hudStageKey = "";
  function syncHudThreats(): void {
    const states = controller.threats.map((t) => ({ id: t.profile.id, stage: t.stage }));
    const key = states.map((s) => `${s.id}:${s.stage}`).join("|");
    if (key !== hudStageKey) {
      hudStageKey = key;
      hud.setThreats(states);
      const current = controller.threats.find((t) => t.profile.id === selected);
      actions.setStage(current?.stage ?? "pending");
    }
  }

  const spawner = new Spawner(scenario, (id) => {
    controller.spawnThreat(id);
    selected = id;
    hud.setSelected(id);
    hudStageKey = "";
  });
  controller.start();

  const actions = mountActions(app, {
onDetect: () => {
      if (!selected) return flashNotice("Select a threat first.");
      if (!controller.detect(selected)) flashNotice("Already detected.");
    },
    onClassify: (label) => {
      if (!selected) return flashNotice("Select a threat first.");
      if (!controller.classify(selected, label)) flashNotice("Detect the threat before classifying.");
    },
    onRespond: (response) => {
      if (!selected) return flashNotice("Select a threat first.");
      if (!controller.respond(selected, response)) flashNotice("Classify the threat before responding.");
    },
    onFalseAlarm: () => controller.falseAlarm(),
    onFinish: () => finish(),
  });

  let noticeTimer = 0;
  function flashNotice(message: string): void {
    actions.setNotice(message);
    window.clearTimeout(noticeTimer);
    noticeTimer = window.setTimeout(() => actions.setNotice(""), 2000);
  }

  // Click a threat in the scene to select it.
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  sim.renderer.domElement.addEventListener("click", (event) => {
    const rect = sim.renderer.domElement.getBoundingClientRect();
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, sim.camera);
    const meshes = [...views.values()].map((v) => v.mesh);
    const hit = raycaster.intersectObjects(meshes, false)[0];
    if (hit) {
      const view = [...views.values()].find((v) => v.mesh === hit.object);
      if (view) { selected = view.profile.id; hud.setSelected(selected); hudStageKey = ""; }
    }
  });

  let finishing = false;
  async function finish(): Promise<void> {
    if (finishing) return;
    finishing = true;
    actions.setEnabled(false);
    controller.complete();
    await chain;
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

    stepFlight(flight, readControls(controls, dt), dt, flightEnv);
    aircraft.position.set(flight.position.x, flight.position.y, flight.position.z);
    aircraft.rotation.set(flight.attitude.x, flight.attitude.y, flight.attitude.z);
    spinRotors(aircraft, elapsedSec);
    // Keep the shadow frustum centred on the aircraft so the tight ortho box
    // always contains what the camera is looking at.
    sim.world.aimSunAt(aircraft.position.x, aircraft.position.y, aircraft.position.z);

    const focusView = selected ? views.get(selected) : undefined;
    applyCamera(
      sim.camera,
      cameraMode,
      {
        state: flight,
        focus: focusView && focusView.mesh.visible
          ? focusView.mesh.position.clone()
          : null,
      },
      dt,
    );

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
    flightHud.update({
      altitude: altitudeAgl(flight, flightEnv),
      speed: speedOf(flight),
      throttle: controls.throttle,
      pitch: flight.attitude.x,
      roll: flight.attitude.z,
      heading: flight.attitude.y,
    });
    sim.render();
    if (!finishing && elapsedSec >= scenario.duration_seconds) {
      void finish();
      return;
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
