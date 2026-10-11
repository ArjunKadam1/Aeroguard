import type {
  Environment, ScenarioGenerateRequest, ThreatCount, TimeOfDay,
} from "../api/types";

const ENVIRONMENTS: Environment[] = ["urban", "rural"];
const TIMES: TimeOfDay[] = ["day", "night"];
const THREAT_COUNTS: ThreatCount[] = [1, 2, 3, 5];

// Mirrors the additive difficulty model in
// backend/app/services/scenario_generator.py. Difficulty is an exact target:
//   difficulty = BASE(1) + threat + environment + time_of_day + residual(0..6)
// so some combinations are unreachable and the API answers 422. The client
// computes the same floor so the form can explain it instead of failing.
const BASE_DIFFICULTY = 1;
const THREAT_FACTOR: Record<ThreatCount, number> = { 1: 0, 2: 1, 3: 2, 5: 4 };
const ENVIRONMENT_FACTOR: Record<Environment, number> = { urban: 1, rural: 0 };
const TIME_FACTOR: Record<TimeOfDay, number> = { day: 0, night: 2 };

export function minimumDifficulty(
  environment: Environment,
  timeOfDay: TimeOfDay,
  threatCount: ThreatCount,
): number {
  return BASE_DIFFICULTY
    + THREAT_FACTOR[threatCount]
    + ENVIRONMENT_FACTOR[environment]
    + TIME_FACTOR[timeOfDay];
}

export interface StartPanelState {
  traineeId: string;
  unit: string;
  difficulty: number;
  environment: Environment;
  timeOfDay: TimeOfDay;
  threatCount: ThreatCount;
  seed: string;
  busy: boolean;
  error: string | null;
}

export interface StartPanel {
  beginLoading(): () => void;
  endLoading(): void;
  showError(message: string): void;
  /** Trainee id and unit currently entered, for the performance dashboard. */
  readIdentity(): { traineeId: string; unit: string | null };
}

export function buildStartPanelHtml(state: StartPanelState): string {
  const floor = minimumDifficulty(state.environment, state.timeOfDay, state.threatCount);
  const tooLow = state.difficulty < floor;
  const briefing = `${state.environment.toUpperCase()} / ${state.timeOfDay.toUpperCase()}`
    + ` &middot; ${state.threatCount} contact${state.threatCount === 1 ? "" : "s"}`
    + ` &middot; difficulty ${state.difficulty}`;
  return `
    <div class="start-page">
      <header class="start-head">
        <div>
          <h1>Aeroguard</h1>
          <p class="start-sub">Counter-UAS threat detection &amp; classification trainer</p>
        </div>
        <span class="start-badge">TRAINING</span>
      </header>

      <form id="start-form" class="start-form">
        <div class="start-error" role="alert"${state.error ? "" : " hidden"}>${
          state.error ?? ""
        }</div>

        <div class="start-grid">
          <label class="start-field">
            <span>Trainee ID</span>
            <input id="trainee_id" name="trainee_id" value="${state.traineeId}" />
          </label>

          <label class="start-field">
            <span>Unit <em class="start-hint">for cohort rollups</em></span>
            <input id="unit" name="unit" value="${state.unit}" />
          </label>

          <label class="start-field">
            <span>Environment</span>
            <select id="environment" name="environment">${options(ENVIRONMENTS, state.environment)}</select>
          </label>

          <label class="start-field">
            <span>Time of day</span>
            <select id="time_of_day" name="time_of_day">${options(TIMES, state.timeOfDay)}</select>
          </label>

          <label class="start-field">
            <span>Threat count</span>
            <select id="threat_count" name="threat_count">${options(THREAT_COUNTS, state.threatCount)}</select>
          </label>

          <label class="start-field">
            <span>Difficulty <em class="start-hint">floor ${floor} for this setup</em></span>
            <input id="difficulty" name="difficulty" type="number" min="${floor}" max="10"
                   value="${state.difficulty}"${tooLow ? " class='is-invalid'" : ""} />
          </label>

          <label class="start-field">
            <span>Seed <em class="start-hint">blank = random</em></span>
            <input id="seed" name="seed" type="number" value="${state.seed}" />
          </label>
        </div>

        <div class="start-briefing${tooLow ? " is-warn" : ""}">
          ${tooLow
            ? `Difficulty ${state.difficulty} is below the minimum ${floor} for this setup.`
            : briefing}
        </div>

        <button type="submit" class="start-submit"${state.busy ? " disabled" : ""}>
          ${state.busy ? "GENERATING…" : "START SCENARIO"}
        </button>
        <button type="button" id="start-performance" class="start-submit start-secondary">
          PERFORMANCE
        </button>
      </form>
    </div>`;
}

function options(values: readonly (string | number)[], selected: string | number): string {
  return values
    .map((v) => `<option value="${v}"${String(v) === String(selected) ? " selected" : ""}>${v}</option>`)
    .join("");
}

// Validates the raw form values without trusting the DOM casts, which is what
// previously sent difficulty: 0 (blank) straight to the API as a 422.
export function parseStartForm(raw: Record<string, string>): {
  request: ScenarioGenerateRequest;
  traineeId: string;
  error: string | null;
} {
  const environment = (raw.environment ?? "urban") as Environment;
  const timeOfDay = (raw.time_of_day ?? "day") as TimeOfDay;
  const threatCount = Number(raw.threat_count ?? 1) as ThreatCount;
  const difficulty = Number(raw.difficulty);
  const floor = minimumDifficulty(environment, timeOfDay, threatCount);

  if (!Number.isFinite(difficulty) || difficulty < floor || difficulty > 10) {
    return {
      request: {
        difficulty: Math.max(1, Math.min(10, difficulty || 1)),
        environment, time_of_day: timeOfDay, threat_count: threatCount, seed: null,
      },
      traineeId: raw.trainee_id ?? "TRAIN-001",
      error: `Difficulty must be between ${floor} and 10 for this setup. `
        + `Night costs +2 and each extra contact +1.`,
    };
  }
  const seedRaw = (raw.seed ?? "").trim();
  return {
    request: {
      difficulty,
      environment,
      time_of_day: timeOfDay,
      threat_count: threatCount,
      seed: seedRaw === "" ? null : Number(seedRaw),
    },
    traineeId: (raw.trainee_id ?? "TRAIN-001").trim() || "TRAIN-001",
    error: null,
  };
}

export function createStartPanelState(): StartPanelState {
  return {
    traineeId: "TRAIN-001",
    unit: "ALPHA-1",
    difficulty: 4,
    environment: "urban",
    timeOfDay: "day",
    threatCount: 2,
    seed: "",
    busy: false,
    error: null,
  };
}

export function mountStartPanel(
  root: HTMLElement,
  onStart: (req: ScenarioGenerateRequest, traineeId: string, unit: string | null) => void,
  onPerformance?: (traineeId: string, unit: string | null) => void,
): StartPanel {
  let state = createStartPanelState();

  const panel = document.createElement("div");
  panel.id = "start-panel";
  root.appendChild(panel);

  function render(): void {
    panel.innerHTML = buildStartPanelHtml(state);
    // Keep the briefing and difficulty floor live as the operator changes the
    // scenario, so an impossible combination is visible before submitting.
    for (const id of ["environment", "time_of_day", "threat_count", "difficulty"]) {
      panel.querySelector<HTMLElement>(`#${id}`)?.addEventListener("change", () => {
        state = {
          ...state,
          environment: readValue("environment") as Environment,
          timeOfDay: readValue("time_of_day") as TimeOfDay,
          threatCount: Number(readValue("threat_count")) as ThreatCount,
          difficulty: Number(readValue("difficulty")) || state.difficulty,
        };
        state.error = null;
        render();
      });
    }
    panel.querySelector<HTMLFormElement>("#start-form")?.addEventListener("submit", onSubmit);
    panel.querySelector<HTMLButtonElement>("#start-performance")?.addEventListener("click", () => {
      const identity = readIdentity();
      onPerformance?.(identity.traineeId, identity.unit);
    });
  }

  function readValue(id: string): string {
    return panel.querySelector<HTMLInputElement>(`#${id}`)?.value ?? "";
  }

  function readIdentity(): { traineeId: string; unit: string | null } {
    const traineeId = readValue("trainee_id").trim() || "TRAIN-001";
    const unit = readValue("unit").trim();
    return { traineeId, unit: unit === "" ? null : unit };
  }

  function onSubmit(event: Event): void {
    event.preventDefault();
    const raw: Record<string, string> = {};
    for (const id of ["trainee_id", "unit", "environment", "time_of_day", "threat_count", "difficulty", "seed"]) {
      raw[id] = readValue(id);
    }
    const { request, traineeId, error } = parseStartForm(raw);
    if (error) {
      state = { ...state, error };
      render();
      return;
    }
    const unit = readIdentity().unit;
    state = { ...state, error: null };
    render();
    onStart(request, traineeId, unit);
  }

  render();

  return {
    beginLoading() {
      state = { ...state, busy: true, error: null };
      render();
      return () => { state = { ...state, busy: false }; render(); };
    },
    endLoading() {
      state = { ...state, busy: false };
      render();
    },
    showError(message) {
      state = { ...state, error: message };
      render();
    },
    readIdentity,
  };
}