"""Deterministic After Action Review facts.

A pure function of (scenario ground truth, recorded events, score). The
narrative text (summary/recommendation) is supplied separately by a
Narrator (see services/aar_narrator.py); everything measurable is computed
here so it is reproducible and testable.

Source of truth: docs/modules/aar_and_adaptive_training.md §1-3, §5.
"""

from __future__ import annotations

from dataclasses import dataclass

from app.schemas.aar import AAR, GroundTruthItem, Mistake, MistakeKind, TimingMetrics
from app.schemas.events import EventCreateRequest, EventType
from app.schemas.scenario import Scenario, ThreatProfile
from app.schemas.scoring import ScoreResult
from app.services.aar_narrator import Narrator, TemplateNarrator
from app.services.scoring import CLASSIFICATION_MAX, DETECTION_MAX, RESPONSE_MAX

TIMING_MAX = 15

_COMPONENTS: tuple[tuple[str, str], ...] = (
    ("detection", "Detection"),
    ("classification", "Classification"),
    ("response", "Response"),
    ("timing", "Timing"),
)


@dataclass(frozen=True)
class AarFacts:
    session_id: str
    scenario_id: str
    final_score: float
    detected: int
    total: int
    classified_correct: int
    responded_correct: int
    false_alarms: int
    timing: TimingMetrics
    mistakes: tuple[Mistake, ...]
    strengths: tuple[str, ...]
    weaknesses: tuple[str, ...]
    weakest_dimension: str


def _first(
    events: list[EventCreateRequest], event_type: EventType, threat_id: str
) -> EventCreateRequest | None:
    for event in events:
        if event.type == event_type and event.threat_id == threat_id:
            return event
    return None


def _spawn_ms(threat: ThreatProfile) -> int:
    return int(round(threat.spawn_time * 1000))


def _mean(values: list[float]) -> float | None:
    if not values:
        return None
    return round(sum(values) / len(values), 2)


def _timing(scenario: Scenario, events: list[EventCreateRequest]) -> TimingMetrics:
    to_detect: list[float] = []
    detect_to_class: list[float] = []
    class_to_response: list[float] = []
    total: list[float] = []
    for threat in scenario.threats:
        detection = _first(events, EventType.THREAT_DETECTED, threat.id)
        if detection is None:
            continue
        to_detect.append(max(0.0, float(detection.timestamp_ms - _spawn_ms(threat))))
        classification = _first(events, EventType.CLASSIFICATION_SUBMITTED, threat.id)
        if classification is not None:
            detect_to_class.append(
                max(0.0, float(classification.timestamp_ms - detection.timestamp_ms))
            )
        response = _first(events, EventType.RESPONSE_SUBMITTED, threat.id)
        if response is not None:
            total.append(
                max(0.0, float(response.timestamp_ms - detection.timestamp_ms))
            )
            if classification is not None:
                class_to_response.append(
                    max(0.0, float(response.timestamp_ms - classification.timestamp_ms))
                )
    return TimingMetrics(
        mean_time_to_detection_ms=_mean(to_detect),
        mean_detection_to_classification_ms=_mean(detect_to_class),
        mean_classification_to_response_ms=_mean(class_to_response),
        mean_total_decision_ms=_mean(total),
    )


def _counts(scenario: Scenario, events: list[EventCreateRequest]) -> tuple[int, int, int]:
    detected = classified = responded = 0
    for threat in scenario.threats:
        detection = _first(events, EventType.THREAT_DETECTED, threat.id)
        if detection is None:
            continue
        detected += 1
        classification = _first(events, EventType.CLASSIFICATION_SUBMITTED, threat.id)
        label = classification.payload.get("label") if classification else None
        if label != threat.classification_label.value:
            continue
        classified += 1
        response = _first(events, EventType.RESPONSE_SUBMITTED, threat.id)
        value = response.payload.get("response") if response else None
        if value == threat.expected_response.value:
            responded += 1
    return detected, classified, responded


def _mistakes(scenario: Scenario, events: list[EventCreateRequest]) -> list[Mistake]:
    mistakes: list[Mistake] = []
    for threat in scenario.threats:
        detection = _first(events, EventType.THREAT_DETECTED, threat.id)
        if detection is None:
            mistakes.append(
                Mistake(
                    kind=MistakeKind.missed_threat,
                    timestamp_ms=_spawn_ms(threat),
                    threat_id=threat.id,
                    detail="no detection recorded",
                )
            )
            continue
        classification = _first(events, EventType.CLASSIFICATION_SUBMITTED, threat.id)
        label = classification.payload.get("label") if classification else None
        if label != threat.classification_label.value:
            got = label if label is not None else "none"
            mistakes.append(
                Mistake(
                    kind=MistakeKind.classification_error,
                    timestamp_ms=classification.timestamp_ms if classification else detection.timestamp_ms,
                    threat_id=threat.id,
                    detail=f"classified '{got}', expected '{threat.classification_label.value}'",
                )
            )
            continue
        response = _first(events, EventType.RESPONSE_SUBMITTED, threat.id)
        value = response.payload.get("response") if response else None
        if value != threat.expected_response.value:
            got = value if value is not None else "none"
            mistakes.append(
                Mistake(
                    kind=MistakeKind.response_error,
                    timestamp_ms=response.timestamp_ms if response else classification.timestamp_ms,
                    threat_id=threat.id,
                    detail=f"responded '{got}', expected '{threat.expected_response.value}'",
                )
            )
    for event in events:
        if event.type == EventType.FALSE_ALARM:
            mistakes.append(
                Mistake(
                    kind=MistakeKind.false_alarm,
                    timestamp_ms=event.timestamp_ms,
                    threat_id=event.threat_id,
                    detail="false alarm",
                )
            )
    return sorted(mistakes, key=lambda m: (m.timestamp_ms, m.threat_id or ""))


def _assessment(score_result: ScoreResult) -> tuple[tuple[str, ...], tuple[str, ...], str]:
    values = {
        "detection": (score_result.detection_score, DETECTION_MAX),
        "classification": (score_result.classification_score, CLASSIFICATION_MAX),
        "response": (score_result.response_score, RESPONSE_MAX),
        "timing": (score_result.timing_score, TIMING_MAX),
    }
    strengths: list[str] = []
    weaknesses: list[str] = []
    worst_name = ""
    worst_lost = -1.0
    for key, label in _COMPONENTS:
        value, maximum = values[key]
        if value >= maximum:
            strengths.append(f"{label}: full marks ({value:.1f}/{maximum}).")
            continue
        lost = maximum - value
        weaknesses.append(f"{label}: lost {lost:.1f} of {maximum}.")
        if lost > worst_lost:
            worst_lost = lost
            worst_name = key
    weakest = worst_name if worst_name else "consistency at the current difficulty"
    return tuple(strengths), tuple(weaknesses), weakest


def build_aar_facts(
    session_id: str,
    scenario: Scenario,
    events: list[EventCreateRequest],
    score_result: ScoreResult,
) -> AarFacts:
    detected, classified, responded = _counts(scenario, events)
    false_alarms = sum(1 for e in events if e.type == EventType.FALSE_ALARM)
    strengths, weaknesses, weakest = _assessment(score_result)
    return AarFacts(
        session_id=session_id,
        scenario_id=scenario.scenario_id,
        final_score=score_result.final_score,
        detected=detected,
        total=len(scenario.threats),
        classified_correct=classified,
        responded_correct=responded,
        false_alarms=false_alarms,
        timing=_timing(scenario, events),
        mistakes=tuple(_mistakes(scenario, events)),
        strengths=strengths,
        weaknesses=weaknesses,
        weakest_dimension=weakest,
    )


def build_aar(
    session_id: str,
    scenario: Scenario,
    events: list[EventCreateRequest],
    score_result: ScoreResult,
    narrator: Narrator | None = None,
) -> AAR:
    facts = build_aar_facts(session_id, scenario, events, score_result)
    narrative = (narrator or TemplateNarrator()).narrate(facts)
    timeline = sorted(events, key=lambda event: event.timestamp_ms)
    return AAR(
        session_id=session_id,
        scenario_id=scenario.scenario_id,
        summary=narrative.summary,
        scores=score_result,
        timing=facts.timing,
        mistakes=list(facts.mistakes),
        strengths=list(facts.strengths),
        weaknesses=list(facts.weaknesses),
        recommendation=narrative.recommendation,
        timeline=timeline,
        ground_truth=[
            GroundTruthItem(
                threat_id=threat.id,
                classification_label=threat.classification_label.value,
                expected_response=threat.expected_response.value,
            )
            for threat in scenario.threats
        ],
    )
