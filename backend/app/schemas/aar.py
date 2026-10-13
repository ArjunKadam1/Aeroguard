"""Pydantic models mirroring the frozen v1 AAR / performance / recommend contract.

Source of truth: docs/api/openapi.yaml (AAR, TimingMetrics, Mistake,
PerformanceProfile, RecommendRequest, RecommendResponse).
"""

from __future__ import annotations

from enum import Enum

from pydantic import BaseModel, Field

from app.schemas.events import EventCreateRequest
from app.schemas.scenario import Environment, ThreatCount, TimeOfDay
from app.schemas.scoring import ScoreResult


class MistakeKind(str, Enum):
    missed_threat = "missed_threat"
    false_alarm = "false_alarm"
    classification_error = "classification_error"
    response_error = "response_error"


class Mistake(BaseModel):
    kind: MistakeKind
    timestamp_ms: int
    threat_id: str | None = None
    detail: str | None = None


class TimingMetrics(BaseModel):
    mean_time_to_detection_ms: float | None = None
    mean_detection_to_classification_ms: float | None = None
    mean_classification_to_response_ms: float | None = None
    mean_total_decision_ms: float | None = None


class GroundTruthItem(BaseModel):
    """One contact's answers. Served only inside the post-completion AAR --
    never during play -- so trainees can study what each signature meant."""

    threat_id: str
    classification_label: str
    expected_response: str


class AAR(BaseModel):
    session_id: str
    scenario_id: str
    summary: str
    scores: ScoreResult
    timing: TimingMetrics
    mistakes: list[Mistake]
    strengths: list[str]
    weaknesses: list[str]
    recommendation: str
    timeline: list[EventCreateRequest]
    ground_truth: list[GroundTruthItem] = []


class PerformanceProfile(BaseModel):
    trainee_id: str
    session_count: int
    detection_accuracy: float = Field(ge=0, le=100)
    classification_accuracy: float = Field(ge=0, le=100)
    response_accuracy: float = Field(ge=0, le=100)
    average_reaction_time_ms: float | None = None
    night_score: float | None = None
    day_score: float | None = None
    multi_threat_score: float | None = None
    low_visibility_score: float | None = None
    urban_score: float | None = None
    rural_score: float | None = None
    clear_visibility_score: float | None = None
    reduced_visibility_score: float | None = None
    poor_visibility_score: float | None = None
    high_sensor_score: float | None = None
    medium_sensor_score: float | None = None
    low_sensor_score: float | None = None
    current_level: int = Field(default=1, ge=1, le=10)


class RecommendRequest(BaseModel):
    trainee_id: str


class RecommendResponse(BaseModel):
    recommended_difficulty: int = Field(ge=1, le=10)
    environment: Environment
    time_of_day: TimeOfDay
    threat_count: ThreatCount
    reason: str
