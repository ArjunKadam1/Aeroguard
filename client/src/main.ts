import * as THREE from "three";
import { createApiClient } from "./api/client";
import type { Scenario } from "./api/types";
import { createSimScene } from "./sim/scene";
import { Spawner } from "./sim/spawner";
import { createThreatView, updateThreatView, THREAT_CRUISE_ALTITUDE, type ThreatView } from "./sim/threats";
import { SessionController } from "./state/session";
import { mountActions } from "./ui/actions";
import { mountHud } from "./ui/hud";
import { mountStartPanel } from "./ui/startPanel";

const api = createApiClient();
const app = document.getElementById("app")!;

function clear(): void {
  app.innerHTML = "";
}

mountStartPanel(app, (request, traineeId) => {
  void runSession(request, traineeId);
});

async function runSession(
  request: Parameters<typeof api.generateScenario>[0],
  traineeId: string,
): Promise<void> {
  const scenario = await api.generateScenario(request);
  const session = await api.createSession({ trainee_id: traineeId, scenario_id: scenario.scenario_id });
  clear();
  startPlay(scenario, session.session_id, traineeId);
}

function startPlay(scenario: Scenario, sessionId: string, traineeId: string): void {
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
    const decisions = new Map(
      [...views.values()].map((v) => [v.profile.id, v.profile] as const),
    );
    const { showAar } = await import("./ui/aar");
    showAar(app, scenario, result, decisions, () => {
      clear();
      mountStartPanel(app, (nextRequest, nextTrainee) => { void runSession(nextRequest, nextTrainee); });
    });
  }

  function frame(): void {
    if (finishing) return;
    const elapsedSec = (performance.now() - startedAt) / 1000;
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
    sim.render();
    if (!finishing && elapsedSec >= scenario.duration_seconds) {
      void finish();
      return;
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
