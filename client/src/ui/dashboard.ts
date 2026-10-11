import type { ApiClient } from "../api/client";
import type {
  PerformanceProfile, SessionHistoryItem, UnitPerformance,
} from "../api/types";
import { buildDashboardHtml } from "./dashboardView";

// Performance dashboard: individual session history plus an optional unit
// rollup. Each fetch degrades independently so one failing endpoint never
// blanks the whole page.
export function showDashboard(
  root: HTMLElement,
  api: ApiClient,
  traineeId: string,
  unit: string | null,
  onBack: () => void,
): void {
  const panel = document.createElement("div");
  panel.id = "dashboard-panel";
  panel.className = "panel";
  root.appendChild(panel);

  let history: SessionHistoryItem[] = [];
  let profile: PerformanceProfile | null = null;
  let unitPerformance: UnitPerformance | null = null;
  let loading = true;
  const errors: string[] = [];

  function render(): void {
    panel.innerHTML = buildDashboardHtml(
      traineeId, unit, history, profile, unitPerformance, loading, errors,
    );
    panel.querySelector<HTMLButtonElement>("#dash-back")?.addEventListener("click", () => {
      panel.remove();
      onBack();
    });
  }

  render();

  void (async () => {
    try {
      history = await api.listSessions(traineeId);
    } catch (error) {
      errors.push(`Session history: ${text(error)}`);
    }
    try {
      profile = await api.fetchPerformance(traineeId);
    } catch (error) {
      errors.push(`Accuracy record: ${text(error)}`);
    }
    // Only meaningful when the session carried a unit.
    if (unit) {
      try {
        unitPerformance = await api.fetchUnitPerformance(unit);
      } catch (error) {
        errors.push(`Unit rollup: ${text(error)}`);
      }
    }
    loading = false;
    render();
  })();
}

function text(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}