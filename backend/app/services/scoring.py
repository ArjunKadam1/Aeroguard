"""Deterministic, explainable scoring engine.

A pure function of (scenario ground truth, recorded events). The client
never scores; the server evaluates observable events against the scenario
(docs/modules/scoring_engine.md §11).

Multi-threat aggregation is proportional: each component earns
(correct threats / total threats) × component_max.

Version history:
- v1: timing rewards the detection→response latency only. Spawn→detection
  (how fast the trainee acquired the contact) is measured in the AAR but
  unscored. Preserved verbatim so historical sessions re-score identically.
- v2: timing is the mean of acquisition (spawn→detection) and decision
  (detection→response) curves on the same tier scale. Component maxima are
  unchanged, so v1 and v2 scores stay on the same 0–100 interpretation.

Source of truth: docs/modules/scoring_engine.md, docs/api/openapi.yaml.
"""

from __future__ import annotations

from app.schemas.events import EventCreateRequest, EventType
from app.schemas.scenario import Scenario, ThreatProfile
from app.schemas.scoring import ScoreResult

SCORING_VERSION = 1
SCORING_VERSION_V2 = 2

DETECTION_MAX = 30
CLASSIFICATION_MAX = 30
RESPONSE_MAX = 25
FALSE_ALARM_PENALTY = 5

TARGET_MS = 3000
TOLERANCE_MS = 3000
MAX_MS = 9000

_TIMING_TIERS: tuple[tuple[float, int], ...] = (
    (TARGET_MS, 15),
    (TARGET_MS + TOLERANCE_MS, 10),
    (MAX_MS, 5),
)


def timing_points(latency_ms: float) -> int:
    for limit, points in _TIMING_TIERS:
        if latency_ms <= limit:
            return points
    return 0


def _first_event(
    events: list[EventCreateRequest], event_type: EventType, threat_id: str
) -> EventCreateRequest | None:
    for event in events:
        if event.type == event_type and event.threat_id == threat_id:
            return event
    return None


def _round2(value: float) -> float:
    return round(value, 2)


def _spawn_ms(threat: ThreatProfile) -> int:
    return int(round(threat.spawn_time * 1000))


def score(
    session_id: str, scenario: Scenario, events: list[EventCreateRequest]
) -> ScoreResult:
    total = len(scenario.threats)
    detected_count = 0
    classification_count = 0
    response_count = 0
    timing_total = 0.0

    if total > 0:
        for threat in scenario.threats:
            detection = _first_event(events, EventType.THREAT_DETECTED, threat.id)
            if detection is None:
                continue
            detected_count += 1

            classification = _first_event(
                events, EventType.CLASSIFICATION_SUBMITTED, threat.id
            )
            label = classification.payload.get("label") if classification else None
            if label != threat.classification_label.value:
                continue
            classification_count += 1

            response = _first_event(events, EventType.RESPONSE_SUBMITTED, threat.id)
            response_value = response.payload.get("response") if response else None
            if response_value != threat.expected_response.value:
                continue
            response_count += 1

            latency_ms = response.timestamp_ms - detection.timestamp_ms
            timing_total += timing_points(max(latency_ms, 0))

    false_alarms = sum(1 for e in events if e.type == EventType.FALSE_ALARM)

    detection_score = _round2(DETECTION_MAX * detected_count / total) if total else 0.0
    classification_score = (
        _round2(CLASSIFICATION_MAX * classification_count / total) if total else 0.0
    )
    response_score = _round2(RESPONSE_MAX * response_count / total) if total else 0.0
    timing_score = _round2(timing_total / total) if total else 0.0
    penalty = _round2(FALSE_ALARM_PENALTY * false_alarms)
    final = _round2(
        detection_score + classification_score + response_score + timing_score - penalty
    )
    final = max(0.0, min(100.0, final))

    return ScoreResult(
        session_id=session_id,
        detection_score=detection_score,
        classification_score=classification_score,
        response_score=response_score,
        timing_score=timing_score,
        penalty=penalty,
        final_score=final,
        scoring_version=SCORING_VERSION,
    )


def score_v2(
    session_id: str, scenario: Scenario, events: list[EventCreateRequest]
) -> ScoreResult:
    """Version 2: identical components and maxima to v1, except timing.

    Per correctly-responded threat, timing is the mean of the acquisition
    curve (spawn→detection: how fast the contact was acquired) and the
    decision curve (detection→response: how fast the decision followed).
    Equal weight: the training loop is observe -> decide, and v1 only
    measured the second half.
    """
    total = len(scenario.threats)
    detected_count = 0
    classification_count = 0
    response_count = 0
    timing_total = 0.0

    if total > 0:
        for threat in scenario.threats:
            detection = _first_event(events, EventType.THREAT_DETECTED, threat.id)
            if detection is None:
                continue
            detected_count += 1

            classification = _first_event(
                events, EventType.CLASSIFICATION_SUBMITTED, threat.id
            )
            label = classification.payload.get("label") if classification else None
            if label != threat.classification_label.value:
                continue
            classification_count += 1

            response = _first_event(events, EventType.RESPONSE_SUBMITTED, threat.id)
            response_value = response.payload.get("response") if response else None
            if response_value != threat.expected_response.value:
                continue
            response_count += 1

            acquisition_ms = max(0.0, float(detection.timestamp_ms - _spawn_ms(threat)))
            decision_ms = max(0.0, float(response.timestamp_ms - detection.timestamp_ms))
            timing_total += (timing_points(acquisition_ms) + timing_points(decision_ms)) / 2

    false_alarms = sum(1 for e in events if e.type == EventType.FALSE_ALARM)

    detection_score = _round2(DETECTION_MAX * detected_count / total) if total else 0.0
    classification_score = (
        _round2(CLASSIFICATION_MAX * classification_count / total) if total else 0.0
    )
    response_score = _round2(RESPONSE_MAX * response_count / total) if total else 0.0
    timing_score = _round2(timing_total / total) if total else 0.0
    penalty = _round2(FALSE_ALARM_PENALTY * false_alarms)
    final = _round2(
        detection_score + classification_score + response_score + timing_score - penalty
    )
    final = max(0.0, min(100.0, final))

    return ScoreResult(
        session_id=session_id,
        detection_score=detection_score,
        classification_score=classification_score,
        response_score=response_score,
        timing_score=timing_score,
        penalty=penalty,
        final_score=final,
        scoring_version=SCORING_VERSION_V2,
    )
