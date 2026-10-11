import type { ApiClient } from "../api/client";
import type { AAR, PerformanceProfile, RecommendResponse } from "../api/types";
import { buildAarHtml } from "./aarView";

// Renders the After Action Review from the server's own AAR, then layers in the
// trainee's adaptive recommendation. The server remains the single source of
// truth for scoring, mistakes and the narrative (ADR-007).
export function showAar(
  root: HTMLElement,
  api: ApiClient,
  sessionId: string,
  traineeId: string,
  fallback: AAR,
  onAgain: () => void,
): void {
  const panel = document.createElement("div");
  panel.id = "aar-panel";
  panel.className = "panel";
  root.appendChild(panel);

  let aar: AAR = fallback;
  let recommendation: RecommendResponse | null = null;
  let profile: PerformanceProfile | null = null;
  let loading = true;

  function render(): void {
    panel.innerHTML = buildAarHtml(aar, recommendation, profile, loading);
    panel.querySelector<HTMLButtonElement>("#again")?.addEventListener("click", () => {
      panel.remove();
      onAgain();
    });
  }

  // Show the local scorecard immediately, then upgrade to the server review.
  render();

  void (async () => {
    try {
      const fetched = await api.fetchAar(sessionId);
      if (fetched) aar = fetched;
    } catch (error) {
      // Keep the locally computed review rather than leaving an empty screen.
      console.error("failed to fetch server AAR", error);
    }
    try {
      recommendation = await api.recommendTraining({ trainee_id: traineeId });
    } catch (error) {
      console.error("failed to fetch training recommendation", error);
    }
    try {
      profile = await api.fetchPerformance(traineeId);
    } catch (error) {
      console.error("failed to fetch performance profile", error);
    }
    loading = false;
    render();
  })();
}