"""Rule-based, explainable adaptive training logic.

Deterministic functions of stored session history. No ML, no randomness
(docs/modules/aar_and_adaptive_training.md §4, §6). Aggregation and
recommendation are pure so they are unit-testable without HTTP.
"""

from __future__ import annotations

from dataclasses import dataclass

from app.schemas.aar import PerformanceProfile, RecommendResponse
from app.schemas.scenario import Environment, TimeOfDay
from app.services.scoring import CLASSIFICATION_MAX, DETECTION_MAX, RESPONSE_MAX

IMPROVE_THRESHOLD = 90.0
DECLINE_THRESHOLD = 60.0
CONDITION_GAP = 15.0
LEVEL_MIN = 1
LEVEL_MAX = 10
MULTI_THREAT_MIN = 2
MULTI_THREAT_TARGET = 3


@dataclass(frozen=True)
class SessionSummary:
    final_score: float
    detection_score: float
    classification_score: float
    response_score: float
    environment: str
    time_of_day: str
    visibility: str
    threat_count: int
    average_reaction_ms: float | None
    sensor_quality: float
    difficulty: int = 1
    timing_score: float = 0.0
    # Observation-loop evidence (M6): mean spawn->detection latency across
    # detected threats, and the share of detections acquired via radar-only
    # tracks. Displayed in recommendations; never changes dimensions.
    mean_acquisition_ms: float | None = None
    radar_detection_share: float | None = None


@dataclass(frozen=True)
class RecommendInput:
    recent_final_scores: list[float]
    overall_score: float | None
    night_score: float | None
    multi_threat_score: float | None
    last_environment: str
    last_time_of_day: str
    last_threat_count: int
    current_level: int
    urban_score: float | None = None
    rural_score: float | None = None
    reduced_visibility_score: float | None = None
    poor_visibility_score: float | None = None
    low_sensor_score: float | None = None
    mean_acquisition_ms: float | None = None
    radar_detection_share: float | None = None


def mean(values: list[float]) -> float | None:
    if not values:
        return None
    return round(sum(values) / len(values), 2)


def decide_difficulty_delta(recent_final_scores: list[float]) -> int:
    if len(recent_final_scores) >= 3 and all(
        score >= IMPROVE_THRESHOLD for score in recent_final_scores[-3:]
    ):
        return 1
    if len(recent_final_scores) >= 2 and all(
        score < DECLINE_THRESHOLD for score in recent_final_scores[-2:]
    ):
        return -1
    return 0


def clamp_level(level: int) -> int:
    return max(LEVEL_MIN, min(LEVEL_MAX, level))


def resolve_current_level(stored_level: int | None, sessions: list[SessionSummary]) -> int:
    """Level to adapt around.

    A stored level is authoritative once the profile row exists. Before that,
    seed from the most recent completed scenario's difficulty so a trainee who
    just played difficulty 6 is not told they are at level 1
    (docs/modules/aar_and_adaptive_training.md §4).
    """
    if stored_level is not None:
        return clamp_level(stored_level)
    if sessions:
        return clamp_level(sessions[-1].difficulty)
    return LEVEL_MIN


def _accuracy(sessions: list[SessionSummary], attr: str, maximum: int) -> float:
    total = sum((getattr(session, attr) / maximum) * 100 for session in sessions)
    return round(total / len(sessions), 2)


def aggregate_performance(
    trainee_id: str, sessions: list[SessionSummary], current_level: int = 1
) -> PerformanceProfile:
    if not sessions:
        return PerformanceProfile(
            trainee_id=trainee_id, session_count=0, detection_accuracy=0.0,
            classification_accuracy=0.0, response_accuracy=0.0,
            current_level=clamp_level(current_level),
        )
    return PerformanceProfile(
        trainee_id=trainee_id,
        session_count=len(sessions),
        detection_accuracy=_accuracy(sessions, "detection_score", DETECTION_MAX),
        classification_accuracy=_accuracy(sessions, "classification_score", CLASSIFICATION_MAX),
        response_accuracy=_accuracy(sessions, "response_score", RESPONSE_MAX),
        average_reaction_time_ms=mean(
            [s.average_reaction_ms for s in sessions if s.average_reaction_ms is not None]
        ),
        day_score=mean([s.final_score for s in sessions if s.time_of_day == "day"]),
        night_score=mean([s.final_score for s in sessions if s.time_of_day == "night"]),
        multi_threat_score=mean(
            [s.final_score for s in sessions if s.threat_count >= MULTI_THREAT_MIN]
        ),
        low_visibility_score=mean(
            [s.final_score for s in sessions if s.visibility != "clear"]
        ),
        urban_score=mean([s.final_score for s in sessions if s.environment == "urban"]),
        rural_score=mean([s.final_score for s in sessions if s.environment == "rural"]),
        clear_visibility_score=mean([s.final_score for s in sessions if s.visibility == "clear"]),
        reduced_visibility_score=mean([s.final_score for s in sessions if s.visibility == "reduced"]),
        poor_visibility_score=mean([s.final_score for s in sessions if s.visibility == "poor"]),
        high_sensor_score=mean([s.final_score for s in sessions if s.sensor_quality >= 0.7]),
        medium_sensor_score=mean([s.final_score for s in sessions if 0.4 <= s.sensor_quality < 0.7]),
        low_sensor_score=mean([s.final_score for s in sessions if s.sensor_quality < 0.4]),
        current_level=clamp_level(current_level),
    )


def _weak(score: float | None, overall: float | None) -> float | None:
    """Return how far `score` trails `overall`, or None when not a weakness."""
    if score is None or overall is None:
        return None
    gap = round(overall - score, 2)
    return gap if gap > CONDITION_GAP else None


def _condition_evidence(data: RecommendInput, overall: float | None) -> str:
    """Metric-cited suffix for visibility/sensor weaknesses (no dimension change)."""
    parts: list[str] = []
    poor_gap = _weak(data.poor_visibility_score, overall)
    if poor_gap is not None:
        parts.append(
            f"poor-visibility score {data.poor_visibility_score:.1f} trails overall "
            f"{overall:.1f} by {poor_gap:.1f}"
        )
    reduced_gap = _weak(data.reduced_visibility_score, overall)
    if reduced_gap is not None:
        parts.append(
            f"reduced-visibility score {data.reduced_visibility_score:.1f} trails overall "
            f"{overall:.1f} by {reduced_gap:.1f}"
        )
    sensor_gap = _weak(data.low_sensor_score, overall)
    if sensor_gap is not None:
        parts.append(
            f"low-sensor score {data.low_sensor_score:.1f} trails overall "
            f"{overall:.1f} by {sensor_gap:.1f}"
        )
    if not parts:
        return ""
    return " Weakened conditions: " + "; ".join(parts) + "."


ACQUISITION_WINDOW_MS = 9000.0


def _observation_evidence(data: RecommendInput) -> str:
    """Evidence from the observation loop: acquisition lag and radar reliance.

    Evidence-only, like _condition_evidence: it explains but never changes a
    dimension, so the tuned difficulty rules are untouched.
    """
    parts: list[str] = []
    if data.mean_acquisition_ms is not None and data.mean_acquisition_ms > ACQUISITION_WINDOW_MS:
        parts.append(
            f"acquisition lag: mean {data.mean_acquisition_ms / 1000:.1f}s from spawn "
            f"to detection is past the {ACQUISITION_WINDOW_MS / 1000:.1f}s timing window; "
            "practice acquiring contacts sooner rather than harder scenarios"
        )
    if data.radar_detection_share is not None and data.radar_detection_share >= 0.5:
        parts.append(
            f"radar reliance: {data.radar_detection_share:.0%} of detections came from "
            "radar-only tracks, and classification needs visual confirmation; "
            "practice closing to visual range"
        )
    if not parts:
        return ""
    return " Observation loop: " + "; ".join(parts) + "."


def build_recommendation(data: RecommendInput) -> RecommendResponse:
    overall = data.overall_score
    environment = Environment(data.last_environment)

    night_gap = _weak(data.night_score, overall)
    multi_gap = _weak(data.multi_threat_score, overall)
    urban_gap = _weak(data.urban_score, overall)
    rural_gap = _weak(data.rural_score, overall)

    if night_gap is not None:
        level = clamp_level(data.current_level)
        response = RecommendResponse(
            recommended_difficulty=level,
            environment=environment,
            time_of_day=TimeOfDay.night,
            threat_count=data.last_threat_count,
            reason=(
                f"Night score {data.night_score:.1f} is {night_gap:.1f} points below overall "
                f"{overall:.1f}; keeping difficulty at {level} and adding night repetitions."
            ),
        )
    elif multi_gap is not None:
        level = clamp_level(data.current_level)
        threat_count = (
            MULTI_THREAT_TARGET
            if data.last_threat_count < MULTI_THREAT_TARGET
            else data.last_threat_count
        )
        response = RecommendResponse(
            recommended_difficulty=level,
            environment=environment,
            time_of_day=TimeOfDay(data.last_time_of_day),
            threat_count=threat_count,  # type: ignore[arg-type]
            reason=(
                f"Multi-threat score {data.multi_threat_score:.1f} is {multi_gap:.1f} points below "
                f"overall {overall:.1f}; recommending a {threat_count}-threat scenario at "
                f"difficulty {level}."
            ),
        )
    elif urban_gap is not None or rural_gap is not None:
        # Exactly one environment dimension changes: repeat the weaker environment
        # at the same difficulty (docs/modules/aar_and_adaptive_training.md §6).
        weak_environment = Environment.urban if (urban_gap or 0) >= (rural_gap or 0) else Environment.rural
        gap = urban_gap if weak_environment is Environment.urban else rural_gap
        weak_score = data.urban_score if weak_environment is Environment.urban else data.rural_score
        level = clamp_level(data.current_level)
        response = RecommendResponse(
            recommended_difficulty=level,
            environment=weak_environment,
            time_of_day=TimeOfDay(data.last_time_of_day),
            threat_count=data.last_threat_count,  # type: ignore[arg-type]
            reason=(
                f"{weak_environment.value} score {weak_score:.1f} is {gap:.1f} points below "
                f"overall {overall:.1f}; repeating {weak_environment.value} scenarios at "
                f"difficulty {level}."
            ),
        )
    else:
        delta = decide_difficulty_delta(data.recent_final_scores)
        level = clamp_level(data.current_level + delta)
        recent_mean = mean(data.recent_final_scores)
        if delta > 0:
            reason = (
                f"Last 3 sessions averaged {recent_mean:.1f} (>= {IMPROVE_THRESHOLD:.0f}); "
                f"increasing difficulty from {data.current_level} to {level}."
            )
        elif delta < 0:
            reason = (
                f"Last 2 sessions averaged {recent_mean:.1f} (< {DECLINE_THRESHOLD:.0f}); "
                f"decreasing difficulty from {data.current_level} to {level}."
            )
        elif overall is None:
            reason = f"No completed sessions yet; starting at difficulty {level}."
        else:
            shown = recent_mean if recent_mean is not None else overall
            reason = (
                f"Recent sessions averaged {shown:.1f}; holding difficulty at {level}. "
                f"Needs 3 sessions at {IMPROVE_THRESHOLD:.0f}+ or 2 below "
                f"{DECLINE_THRESHOLD:.0f} to change."
            )
        response = RecommendResponse(
            recommended_difficulty=level,
            environment=environment,
            time_of_day=TimeOfDay(data.last_time_of_day),
            threat_count=data.last_threat_count,  # type: ignore[arg-type]
            reason=reason,
        )
    evidence = _condition_evidence(data, overall)
    if evidence:
        response.reason += evidence
    observation = _observation_evidence(data)
    if observation:
        response.reason += observation
    return response
