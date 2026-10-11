import type { HudStage } from "./hud";
import type { ClassificationLabel, ExpectedResponse } from "../api/types";

const LABELS: ClassificationLabel[] = ["friendly", "civilian", "unknown", "suspicious", "hostile"];
const RESPONSES: ExpectedResponse[] = ["monitor", "track", "report", "hold"];

export type ActionGroup = "detect" | "classify" | "respond";

export const ACTION_GROUPS: ActionGroup[] = ["detect", "classify", "respond"];

// Which decision group is legal for a given threat stage. The session state
// machine enforces the same order (state/session.ts), this only decides what
// the trainee is offered so an impossible action is never clickable.
const STAGE_GROUP: Record<HudStage, ActionGroup | null> = {
  pending: null,
  spawned: "detect",
  detected: "classify",
  classified: "respond",
  responded: null,
};

export function enabledGroupFor(stage: HudStage): ActionGroup | null {
  return STAGE_GROUP[stage];
}

export function isGroupEnabled(stage: HudStage, group: ActionGroup): boolean {
  return STAGE_GROUP[stage] === group;
}

export interface ActionHooks {
  onDetect(): void;
  onClassify(label: ClassificationLabel): void;
  onRespond(response: ExpectedResponse): void;
  onFalseAlarm(): void;
  onFinish(): void;
}

export interface Actions {
  root: HTMLElement;
  setEnabled(enabled: boolean): void;
  setStage(stage: HudStage): void;
  setNotice(message: string): void;
}

export function mountActions(root: HTMLElement, hooks: ActionHooks): Actions {
  const element = document.createElement("div");
  element.id = "actions";
  element.className = "panel";
  element.innerHTML = `
    <div class="action-groups">
      <div class="action-group" data-group="detect">
        <span class="action-group-label">Detect</span>
        <button data-action="detect">DETECT</button>
      </div>
      <div class="action-group" data-group="classify">
        <span class="action-group-label">Classify</span>
        ${LABELS.map((l) => `<button data-classify="${l}">${l}</button>`).join("")}
      </div>
      <div class="action-group" data-group="respond">
        <span class="action-group-label">Respond</span>
        ${RESPONSES.map((r) => `<button data-respond="${r}">${r}</button>`).join("")}
      </div>
      <div class="action-group action-group-secondary">
        <button data-action="false-alarm">FALSE ALARM</button>
        <button data-action="finish">FINISH</button>
      </div>
    </div>
    <div class="action-notice" role="status"></div>`;
  root.appendChild(element);

  const notice = element.querySelector<HTMLElement>(".action-notice")!;

  function applyGroupState(activeGroup: ActionGroup | null, enabled: boolean): void {
    for (const group of element.querySelectorAll<HTMLElement>(".action-group[data-group]")) {
      const isActive = activeGroup !== null && group.dataset.group === activeGroup;
      group.classList.toggle("is-active", isActive);
      group.querySelectorAll("button").forEach((b) => {
        (b as HTMLButtonElement).disabled = !enabled || !isActive;
      });
    }
    // FALSE ALARM and FINISH stay available whenever the session is live.
    element
      .querySelectorAll<HTMLElement>(".action-group-secondary button")
      .forEach((b) => ((b as HTMLButtonElement).disabled = !enabled));
  }

  applyGroupState(null, true);

  element.addEventListener("click", (event) => {
    const target = event.target as HTMLButtonElement;
    if (target.dataset.action === "detect") hooks.onDetect();
    if (target.dataset.action === "false-alarm") hooks.onFalseAlarm();
    if (target.dataset.action === "finish") hooks.onFinish();
    const classify = target.dataset.classify as ClassificationLabel | undefined;
    if (classify) hooks.onClassify(classify);
    const respond = target.dataset.respond as ExpectedResponse | undefined;
    if (respond) hooks.onRespond(respond);
  });

  let enabled = true;
  let stage: HudStage = "pending";
  return {
    root: element,
    setEnabled: (value) => {
      enabled = value;
      applyGroupState(enabledGroupFor(stage), enabled);
    },
    setStage: (value) => {
      stage = value;
      applyGroupState(enabledGroupFor(stage), enabled);
    },
    setNotice: (message) => {
      notice.textContent = message;
    },
  };
}
