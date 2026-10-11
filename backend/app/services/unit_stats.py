"""Cohort-level performance rollups for a unit.

Pure functions over stored session summaries, mirroring services/adaptive.py:
no database access, no HTTP, so they are unit-testable directly. Aggregation
reuses the adaptive engine's condition metrics so the unit view and the
per-trainee view always agree on how a condition scores.

Source of truth: docs/modules/aar_and_adaptive_training.md and the SIH outcome
"AAR dashboard tracking individual/unit performance over repeated sessions".
"""

from __future__ import annotations

from pydantic import BaseModel, Field

from app.services.adaptive import (
    CLASSIFICATION_MAX,
    CONDITION_GAP,
    DETECTION_MAX,
    RESPONSE_MAX,
    SessionSummary,
    mean,
)


class UnitWeakness(BaseModel):
    """A condition where the unit trails its own overall score."""

    condition: str
    score: float
    gap: float


class UnitPerformance(BaseModel):
    """Aggregate performance for every completed session in a unit."""

    unit: str
    session_count: int = Field(ge=0)
    trainee_count: int = Field(ge=0)
    mean_final_score: float | None = None
    best_final_score: float | None = None
    detection_accuracy: float = Field(ge=0, le=100, default=0.0)
    classification_accuracy: float = Field(ge=0, le=100, default=0.0)
    response_accuracy: float = Field(ge=0, le=100, default=0.0)
    average_reaction_time_ms: float | None = None
    mean_timing_score: float | None = None
    weaknesses: list[UnitWeakness] = Field(default_factory=list)


def _accuracy(sessions: list[SessionSummary], attr: str, maximum: int) -> float:
    if not sessions:
        return 0.0
    total = sum((getattr(s, attr) / maximum) * 100 for s in sessions)
    return round(total / len(sessions), 2)


# Conditions surfaced in the unit rollup. Kept small and meaningful: these are
# the axes the adaptive engine reasons about when it recommends the next
# scenario, so a unit weakness here is directly actionable.
UNIT_CONDITIONS: tuple[tuple[str, str, str], ...] = (
    ("day_score", "Day", "time_of_day"),
    ("night_score", "Night", "time_of_day"),
    ("multi_threat_score", "Multi-threat", "threat_count"),
    ("urban_score", "Urban", "environment"),
    ("rural_score", "Rural", "environment"),
    ("clear_visibility_score", "Clear visibility", "visibility"),
    ("reduced_visibility_score", "Reduced visibility", "visibility"),
    ("poor_visibility_score", "Poor visibility", "visibility"),
)


def unit_weaknesses(
    unit_sessions: list[SessionSummary],
    condition_scores: dict[str, float | None],
    overall: float,
) -> list[UnitWeakness]:
    """Conditions trailing the unit mean by more than CONDITION_GAP.

    Same threshold the adaptive engine applies per trainee, so a weakness shown
    here means the same thing as one shown on an individual review.
    """
    if not unit_sessions or overall is None:
        return []
    found: list[UnitWeakness] = []
    for attr, label, _axis in UNIT_CONDITIONS:
        score = condition_scores.get(attr)
        if score is None:
            # Condition never exercised by this unit; not a weakness.
            continue
        gap = round(overall - score, 2)
        if gap > CONDITION_GAP:
            found.append(UnitWeakness(condition=label, score=round(score, 2), gap=gap))
    # Worst gap first, so the most significant weakness leads.
    found.sort(key=lambda w: w.gap, reverse=True)
    return found


def rollup_unit(
    unit: str,
    sessions: list[SessionSummary],
    condition_scores: dict[str, float | None],
    trainee_count: int,
) -> UnitPerformance:
    """Aggregate completed sessions for a unit.

    ``condition_scores`` holds the per-condition means already computed by
    aggregate_performance(), keyed by the attribute names in UNIT_CONDITIONS.
    """
    if not sessions:
        return UnitPerformance(
            unit=unit,
            session_count=0,
            trainee_count=trainee_count,
            detection_accuracy=0.0,
            classification_accuracy=0.0,
            response_accuracy=0.0,
        )

    from app.services.adaptive import DETECTION_MAX, RESPONSE_MAX, CLASSIFICATION_MAX

    finals = [s.final_score for s in sessions]
    overall = mean(finals)
    return UnitPerformance(
        unit=unit,
        session_count=len(sessions),
        trainee_count=trainee_count,
        mean_final_score=overall,
        best_final_score=max(finals),
        detection_accuracy=_accuracy(sessions, "detection_score", DETECTION_MAX),
        classification_accuracy=_accuracy(sessions, "classification_score", CLASSIFICATION_MAX),
        response_accuracy=_accuracy(sessions, "response_score", RESPONSE_MAX),
        average_reaction_time_ms=mean(
            [s.average_reaction_ms for s in sessions if s.average_reaction_ms is not None]
        ),
        mean_timing_score=mean([s.timing_score for s in sessions]),
        weaknesses=unit_weaknesses(sessions, condition_scores, overall or 0.0),
    )