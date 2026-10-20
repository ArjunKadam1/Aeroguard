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
  /** Clicks the nth enabled button of the active group; false when out of range. */
  triggerSlot(index: number): boolean;
}

export function mountActions(root: HTMLElement, hooks: ActionHooks): Actions {
  const element = document.createElement("div");
  element.id = "actions";
  element.className = "panel";
  element.innerHTML = `
    <div class="action-groups">
      <div class="action-steps" aria-hidden="true">
        <span class="action-step" data-step="detect">1 Detect</span>
        <span class="action-step" data-step="classify">2 Classify</span>
        <span class="action-step" data-step="respond">3 Respond</span>
      </div>
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
    <div class="action-notice" role="status"></div>
    <div class="action-hint" aria-hidden="true">Keys: 1-5 stage actions &middot; Enter assistant &middot; Tab next contact</div>`;
  root.appendChild(element);

  const notice = element.querySelector<HTMLElement>(".action-notice")!;

  // Workflow order mirrors the session state machine: detect -> classify ->
  // respond. Steps at or before the active group read as done; the active
  // group reads as current.
  const STEP_ORDER: ActionGroup[] = ["detect", "classify", "respond"];
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
    const activeIndex = activeGroup ? STEP_ORDER.indexOf(activeGroup) : -1;
    element.querySelectorAll<HTMLElement>(".action-step[data-step]").forEach((step) => {
      const index = STEP_ORDER.indexOf(step.dataset.step as ActionGroup);
      step.classList.toggle("is-done", enabled && activeIndex >= 0 && index < activeIndex);
      step.classList.toggle("is-current", enabled && step.dataset.step === activeGroup);
    });
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
    triggerSlot: (index) => {
      // Clicks the nth enabled button of the active group (detect: 1, classify:
      // 1-5, respond: 1-4). Reusing the real buttons means a shortcut can never
      // bypass a gate or drift from what the trainee could click by hand.
      const buttons = element.querySelectorAll<HTMLButtonElement>(
        ".action-group.is-active button:not(:disabled)",
      );
      const button = buttons[index];
      if (button === undefined) return false;
      button.click();
      return true;
    },
  };
}
