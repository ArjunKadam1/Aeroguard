import type { ApiClient } from "../api/client";
import type { AAR, PerformanceProfile, RecommendResponse, Scenario } from "../api/types";
import { buildAarHtml, type SessionHeader } from "./aarView";

// Renders the After Action Review from the server's own AAR, then layers in the
// trainee's adaptive recommendation. The server remains the single source of
// truth for scoring, mistakes and the narrative (ADR-007).
export function showAar(
  root: HTMLElement,
  api: ApiClient,
  sessionId: string,
  traineeId: string,
  scenario: Scenario,
  fallback: AAR,
  onAgain: () => void,
  unit: string | null = null,
): void {
  const panel = document.createElement("div");
  panel.id = "aar-panel";
  panel.className = "panel";
  root.appendChild(panel);

  const header: SessionHeader = {
    scenarioId: scenario.scenario_id,
    environment: scenario.environment,
    timeOfDay: scenario.time_of_day,
    difficulty: scenario.difficulty,
    durationSeconds: scenario.duration_seconds,
    threatCount: scenario.threats.length,
    unit,
  };

  let aar: AAR = fallback;
  let recommendation: RecommendResponse | null = null;
  let profile: PerformanceProfile | null = null;
  let loading = true;
  // Each fetch fails independently, so collect what went wrong and surface it
  // rather than silently leaving a permanently placeholder-looking page.
  const errors: string[] = [];

  function render(): void {
    panel.innerHTML = buildAarHtml(aar, recommendation, profile, loading, header, errors);
    panel.querySelector<HTMLButtonElement>("#again")?.addEventListener("click", () => {
      panel.remove();
      onAgain();
    });
    panel.querySelector<HTMLButtonElement>("#aar-performance")?.addEventListener("click", () => {
      panel.remove();
      // Same identity the session was created with, so the dashboard can scope
      // both the individual's history and the unit rollup.
      void import("./dashboard").then(({ showDashboard }) => {
        showDashboard(root, api, traineeId, header.unit, () => {
          // Back returns to the setup screen; the review is finished.
          onAgain();
        });
      });
    });
  }

  // Show the local scorecard immediately, then upgrade to the server review.
  render();

  void (async () => {
    try {
      const fetched = await api.fetchAar(sessionId);
      if (fetched) aar = fetched;
      else errors.push("Server review unavailable.");
    } catch (error) {
      errors.push(`Review: ${errorText(error)}`);
    }
    try {
      recommendation = await api.recommendTraining({ trainee_id: traineeId });
    } catch (error) {
      errors.push(`Recommendation: ${errorText(error)}`);
    }
    try {
      profile = await api.fetchPerformance(traineeId);
    } catch (error) {
      errors.push(`Performance history: ${errorText(error)}`);
    }
    loading = false;
    render();
  })();
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}