from __future__ import annotations

from app.schemas.aar import MistakeKind
from app.schemas.events import EventCreateRequest
from app.schemas.scenario import Scenario
from app.schemas.scoring import ScoreResult
from app.services.aar import build_aar_facts
from app.services.scoring import score


def _scenario(*threats: dict) -> Scenario:
    return Scenario(
        scenario_id="SCN-000001", seed=1, generator_version="1.0", difficulty=3,
        environment="rural", time_of_day="day", visibility="clear",
        sensor_quality=0.9, duration_seconds=120.0, threats=list(threats),
    )


_HOSTILE = {
    "id": "T01", "classification_label": "hostile", "expected_response": "hold",
    "spawn_time": 10.0, "speed_class": "fast",
}


def _score(scenario, events) -> ScoreResult:
    return score("SES-TEST", scenario, events)


def test_perfect_session_has_no_mistakes_and_full_strengths() -> None:
    scenario = _scenario(_HOSTILE)
    events = [
        EventCreateRequest(type="THREAT_DETECTED", timestamp_ms=10500, threat_id="T01"),
        EventCreateRequest(
            type="CLASSIFICATION_SUBMITTED", timestamp_ms=11500, threat_id="T01",
            payload={"label": "hostile"},
        ),
        EventCreateRequest(
            type="RESPONSE_SUBMITTED", timestamp_ms=12500, threat_id="T01",
            payload={"response": "hold"},
        ),
    ]
    facts = build_aar_facts("SES-TEST", scenario, events, _score(scenario, events))
    assert (facts.detected, facts.classified_correct, facts.responded_correct) == (1, 1, 1)
    assert facts.false_alarms == 0
    assert facts.mistakes == ()
    assert any("Detection" in s for s in facts.strengths)
    assert facts.weakest_dimension == "consistency at the current difficulty"


def test_timing_metrics_use_spawn_and_stage_gaps() -> None:
    scenario = _scenario(_HOSTILE)
    events = [
        EventCreateRequest(type="THREAT_DETECTED", timestamp_ms=10500, threat_id="T01"),
        EventCreateRequest(
            type="CLASSIFICATION_SUBMITTED", timestamp_ms=11500, threat_id="T01",
            payload={"label": "hostile"},
        ),
        EventCreateRequest(
            type="RESPONSE_SUBMITTED", timestamp_ms=13500, threat_id="T01",
            payload={"response": "hold"},
        ),
    ]
    facts = build_aar_facts("SES-TEST", scenario, events, _score(scenario, events))
    assert facts.timing.mean_time_to_detection_ms == 500.0
    assert facts.timing.mean_detection_to_classification_ms == 1000.0
    assert facts.timing.mean_classification_to_response_ms == 2000.0
    assert facts.timing.mean_total_decision_ms == 3000.0


def test_missed_threat_is_recorded() -> None:
    scenario = _scenario(_HOSTILE)
    facts = build_aar_facts("SES-TEST", scenario, [], _score(scenario, []))
    kinds = [m.kind for m in facts.mistakes]
    assert MistakeKind.missed_threat in kinds
    assert facts.timing.mean_time_to_detection_ms is None


def test_missed_threat_names_the_flight_pattern() -> None:
    scenario = _scenario({
        "id": "T01", "classification_label": "hostile", "expected_response": "hold",
        "spawn_time": 10.0, "speed_class": "fast", "flight_pattern": "erratic-jink",
    })
    facts = build_aar_facts("SES-TEST", scenario, [], _score(scenario, []))
    assert len(facts.mistakes) == 1
    assert facts.mistakes[0].detail == "no detection recorded (flying erratic-jink)"


def test_missed_threat_without_pattern_has_no_clause() -> None:
    scenario = _scenario(_HOSTILE)
    facts = build_aar_facts("SES-TEST", scenario, [], _score(scenario, []))
    assert len(facts.mistakes) == 1
    assert facts.mistakes[0].detail == "no detection recorded"


def test_false_alarm_and_wrong_classification_and_wrong_response() -> None:
    scenario = _scenario(
        {"id": "T01", "classification_label": "hostile", "expected_response": "hold",
         "spawn_time": 5.0, "speed_class": "fast"},
        {"id": "T02", "classification_label": "friendly", "expected_response": "monitor",
         "spawn_time": 20.0, "speed_class": "medium"},
    )
    events = [
        # T01: detected, wrong classification
        EventCreateRequest(type="THREAT_DETECTED", timestamp_ms=6000, threat_id="T01"),
        EventCreateRequest(
            type="CLASSIFICATION_SUBMITTED", timestamp_ms=7000, threat_id="T01",
            payload={"label": "unknown"},
        ),
        # T02: detected, correct classification, wrong response
        EventCreateRequest(type="THREAT_DETECTED", timestamp_ms=21000, threat_id="T02"),
        EventCreateRequest(
            type="CLASSIFICATION_SUBMITTED", timestamp_ms=22000, threat_id="T02",
            payload={"label": "friendly"},
        ),
        EventCreateRequest(
            type="RESPONSE_SUBMITTED", timestamp_ms=23000, threat_id="T02",
            payload={"response": "hold"},
        ),
        EventCreateRequest(type="FALSE_ALARM", timestamp_ms=30000),
    ]
    facts = build_aar_facts("SES-TEST", scenario, events, _score(scenario, events))
    kinds = {m.kind for m in facts.mistakes}
    assert kinds == {
        MistakeKind.classification_error, MistakeKind.response_error, MistakeKind.false_alarm,
    }
    assert facts.false_alarms == 1
    # mistakes are ordered by timestamp
    assert [m.timestamp_ms for m in facts.mistakes] == sorted(m.timestamp_ms for m in facts.mistakes)


def test_build_aar_assembles_narrative_and_ordered_timeline() -> None:
    from app.services.aar import build_aar

    scenario = _scenario(_HOSTILE)
    events = [
        EventCreateRequest(
            type="RESPONSE_SUBMITTED", timestamp_ms=12000, threat_id="T01",
            payload={"response": "hold"},
        ),
        EventCreateRequest(type="THREAT_DETECTED", timestamp_ms=10500, threat_id="T01"),
        EventCreateRequest(
            type="CLASSIFICATION_SUBMITTED", timestamp_ms=11000, threat_id="T01",
            payload={"label": "hostile"},
        ),
    ]
    aar = build_aar("SES-TEST", scenario, events, _score(scenario, events))
    assert aar.scenario_id == "SCN-000001"
    assert aar.summary.startswith("Final score")
    assert [e.timestamp_ms for e in aar.timeline] == [10500, 11000, 12000]
    assert aar.scores.final_score == 100.0
