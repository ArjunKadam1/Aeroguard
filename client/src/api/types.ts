export type Environment = "urban" | "rural";
export type TimeOfDay = "day" | "night";
export type Visibility = "clear" | "reduced" | "poor";
export type ClassificationLabel = "friendly" | "civilian" | "unknown" | "suspicious" | "hostile";
export type ExpectedResponse = "monitor" | "track" | "report" | "hold";
export type SpeedClass = "slow" | "medium" | "fast";
export type ThreatCount = 1 | 2 | 3 | 5;

export interface ScenarioGenerateRequest {
  difficulty: number;
  environment: Environment;
  time_of_day: TimeOfDay;
  threat_count: ThreatCount;
  seed?: number | null;
}

export interface ThreatProfile {
  id: string;
  category: string;
  classification_label: ClassificationLabel;
  expected_response: ExpectedResponse;
  spawn_time: number;
  speed_class: SpeedClass | null;
  visibility_class: Visibility | null;
}

export interface Scenario {
  scenario_id: string;
  seed: number;
  generator_version: string;
  difficulty: number;
  environment: Environment;
  time_of_day: TimeOfDay;
  visibility: Visibility;
  sensor_quality: number;
  duration_seconds: number;
  threats: ThreatProfile[];
}

export interface SessionCreateRequest {
  trainee_id: string;
  scenario_id: string;
  /** Optional cohort grouping for unit-level performance rollups. */
  unit?: string | null;
}
export interface SessionCreated { session_id: string; status: "active"; }

export type EventType =
  | "SESSION_STARTED" | "SCENARIO_LOADED" | "THREAT_SPAWNED"
  | "THREAT_DETECTED" | "CLASSIFICATION_SUBMITTED" | "RESPONSE_SUBMITTED"
  | "FALSE_ALARM" | "THREAT_MISSED" | "THREAT_RESOLVED"
  | "SESSION_PAUSED" | "SESSION_RESUMED" | "SESSION_COMPLETED";

export interface EventCreateRequest {
  type: EventType;
  timestamp_ms: number;
  threat_id?: string | null;
  payload?: Record<string, unknown>;
}
export interface EventCreated { event_id: string; accepted: boolean; }

export interface CompleteResponse {
  session_id: string;
  detection_score: number;
  classification_score: number;
  response_score: number;
  timing_score: number;
  penalty: number;
  final_score: number;
  aar_available: boolean;
  scoring_version: number;
}

// Scoring maxima live in backend/app/services/scoring.py. The API does not
// expose them, so they are declared once here rather than being copied into a
// template. Update both places together if scoring_version is bumped.
export const SCORING_MAXIMA = {
  detection: 30,
  classification: 30,
  response: 25,
  timing: 15,
} as const;

// --- After Action Review (mirrors backend/app/schemas/aar.py) ------------

export type MistakeKind =
  | "missed_threat" | "false_alarm" | "classification_error" | "response_error";

export interface Mistake {
  kind: MistakeKind;
  timestamp_ms: number;
  threat_id: string | null;
  detail: string | null;
}

// Every field is nullable because the server returns null when a condition was
// never exercised in a session.
export interface TimingMetrics {
  mean_time_to_detection_ms: number | null;
  mean_detection_to_classification_ms: number | null;
  mean_classification_to_response_ms: number | null;
  mean_total_decision_ms: number | null;
}

export interface ScoreResult {
  session_id: string;
  detection_score: number;
  classification_score: number;
  response_score: number;
  timing_score: number;
  penalty: number;
  final_score: number;
  scoring_version: number;
}

export interface AAR {
  session_id: string;
  scenario_id: string;
  /** Server-authored narrative. Uses the LLM narrator when configured. */
  summary: string;
  scores: ScoreResult;
  timing: TimingMetrics;
  mistakes: Mistake[];
  strengths: string[];
  weaknesses: string[];
  recommendation: string;
  timeline: EventCreateRequest[];
}

export interface PerformanceProfile {
  trainee_id: string;
  session_count: number;
  detection_accuracy: number;
  classification_accuracy: number;
  response_accuracy: number;
  average_reaction_time_ms: number | null;
  night_score: number | null;
  day_score: number | null;
  multi_threat_score: number | null;
  low_visibility_score: number | null;
  urban_score: number | null;
  rural_score: number | null;
  clear_visibility_score: number | null;
  reduced_visibility_score: number | null;
  poor_visibility_score: number | null;
  high_sensor_score: number | null;
  medium_sensor_score: number | null;
  low_sensor_score: number | null;
  current_level: number;
}

export interface RecommendRequest { trainee_id: string; }

export interface RecommendResponse {
  recommended_difficulty: number;
  environment: Environment;
  time_of_day: TimeOfDay;
  threat_count: ThreatCount;
  /** Metric-cited explanation, e.g. "Night score 58.0 is 15.0 below overall". */
  reason: string;
}

// --- Dashboard -------------------------------------------------------------

/** One completed session, from GET /trainees/{id}/sessions (newest first). */
export interface SessionHistoryItem {
  session_id: string;
  scenario_id: string;
  unit: string | null;
  completed_at: string | null;
  final_score: number;
  environment: Environment;
  time_of_day: TimeOfDay;
  difficulty: number;
  threat_count: number;
}

export interface UnitWeakness {
  condition: string;
  score: number;
  /** Points this condition trails the unit mean. */
  gap: number;
}

/** Aggregate across every completed session in a unit. */
export interface UnitPerformance {
  unit: string;
  session_count: number;
  trainee_count: number;
  mean_final_score: number | null;
  best_final_score: number | null;
  detection_accuracy: number;
  classification_accuracy: number;
  response_accuracy: number;
  average_reaction_time_ms: number | null;
  mean_timing_score: number | null;
  weaknesses: UnitWeakness[];
}

