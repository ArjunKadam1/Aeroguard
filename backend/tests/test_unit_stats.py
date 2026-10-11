from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.services.adaptive import SessionSummary
from app.services.unit_stats import UnitPerformance, rollup_unit, unit_weaknesses


def _summary(
    final=80.0, detection=24.0, classification=24.0, response=20.0, timing=10.0,
    time_of_day="day", visibility="clear", threat_count=1, reaction=2000.0,
    environment="urban", sensor_quality=0.8,
) -> SessionSummary:
    return SessionSummary(
        final_score=final, detection_score=detection, classification_score=classification,
        response_score=response, timing_score=timing, environment=environment,
        time_of_day=time_of_day, visibility=visibility, threat_count=threat_count,
        average_reaction_ms=reaction, sensor_quality=sensor_quality,
    )


def test_rollup_empty_unit_is_zeroed() -> None:
    result = rollup_unit("ALPHA-1", [], {}, 0)
    assert result.session_count == 0
    assert result.trainee_count == 0
    assert result.mean_final_score is None
    assert result.weaknesses == []
    assert result.detection_accuracy == 0.0


def test_rollup_aggregates_across_sessions() -> None:
    sessions = [
        _summary(final=100.0, detection=30.0, classification=30.0, response=25.0, timing=15.0),
        _summary(final=60.0, detection=30.0, classification=0.0, response=0.0, timing=0.0),
    ]
    result = rollup_unit("ALPHA-1", sessions, {}, 2)
    assert result.unit == "ALPHA-1"
    assert result.session_count == 2
    assert result.mean_final_score == 80.0
    assert result.best_final_score == 100.0
    assert result.detection_accuracy == 100.0
    assert result.classification_accuracy == 50.0
    assert result.response_accuracy == 50.0


def test_rollup_mean_timing_and_reaction() -> None:
    sessions = [_summary(timing=10.0, reaction=2000.0), _summary(timing=5.0, reaction=4000.0)]
    result = rollup_unit("ALPHA-1", sessions, {}, 1)
    assert result.mean_timing_score == 7.5
    assert result.average_reaction_time_ms == 3000.0


def test_rollup_ignores_missing_reaction_times() -> None:
    sessions = [_summary(reaction=2000.0), _summary(reaction=None)]
    result = rollup_unit("ALPHA-1", sessions, {}, 1)
    assert result.average_reaction_time_ms == 2000.0


def test_weaknesses_flag_conditions_tailing_the_mean() -> None:
    conditions = {"night_score": 50.0, "day_score": 95.0, "urban_score": 90.0}
    found = unit_weaknesses([_summary()] * 3, conditions, overall=85.0)
    names = [w.condition for w in found]
    # Night trails by 35 (> 15) and is the only genuine weakness.
    assert "Night" in names
    assert "Day" not in names
    assert "Urban" not in names


def test_weaknesses_are_ordered_worst_first() -> None:
    conditions = {"night_score": 50.0, "multi_threat_score": 40.0}
    found = unit_weaknesses([_summary()], conditions, overall=90.0)
    assert found[0].condition == "Multi-threat"
    assert found[0].gap > found[1].gap


def test_weaknesses_skip_conditions_never_exercised() -> None:
    # A null condition is "no data", not a weakness.
    found = unit_weaknesses([_summary()], {"night_score": None}, overall=85.0)
    assert found == []


def test_weaknesses_empty_without_history() -> None:
    assert unit_weaknesses([], {"night_score": 10.0}, 85.0) == []


def test_rollup_validates_through_the_schema() -> None:
    result = UnitPerformance(unit="X", session_count=1, trainee_count=1)
    assert result.mean_final_score is None
    with pytest.raises(ValueError):
        UnitPerformance(unit="X", session_count=1, trainee_count=1, detection_accuracy=140.0)


# ---------------------------------------------------------------------------
# HTTP surface
# ---------------------------------------------------------------------------


def _scenario(client, seed: int, difficulty: int = 3, environment="rural"):
    return client.post(
        "/api/v1/scenarios/generate",
        json={"difficulty": difficulty, "environment": environment, "time_of_day": "day",
              "threat_count": 1, "seed": seed},
    ).json()


def _play(client, scenario, trainee: str, unit: str | None = None) -> str:
    session = client.post(
        "/api/v1/sessions",
        json={"trainee_id": trainee, "scenario_id": scenario["scenario_id"], "unit": unit},
    ).json()
    client.post(f"/api/v1/sessions/{session['session_id']}/complete")
    return session["session_id"]


def test_session_records_the_unit(client) -> None:
    scenario = _scenario(client, 1)
    session = client.post(
        "/api/v1/sessions",
        json={"trainee_id": "T1", "scenario_id": scenario["scenario_id"], "unit": "ALPHA-1"},
    ).json()
    # History only lists completed sessions.
    client.post(f"/api/v1/sessions/{session['session_id']}/complete")
    history = client.get("/api/v1/trainees/T1/sessions").json()
    assert history[0]["unit"] == "ALPHA-1"


def test_unit_is_optional_and_defaults_to_null(client) -> None:
    scenario = _scenario(client, 2)
    session = client.post(
        "/api/v1/sessions",
        json={"trainee_id": "T2", "scenario_id": scenario["scenario_id"]},
    )
    assert session.status_code == 201
    client.post(f"/api/v1/sessions/{session.json()['session_id']}/complete")
    history = client.get("/api/v1/trainees/T2/sessions").json()
    assert history[0]["unit"] is None


def test_session_history_lists_completed_sessions(client) -> None:
    _play(client, _scenario(client, 3), "T3")
    _play(client, _scenario(client, 4), "T3")
    history = client.get("/api/v1/trainees/T3/sessions").json()
    assert len(history) == 2
    entry = history[0]
    for key in ("session_id", "scenario_id", "final_score", "environment",
                "time_of_day", "difficulty", "threat_count"):
        assert key in entry


def test_session_history_excludes_active_sessions(client) -> None:
    scenario = _scenario(client, 5)
    client.post("/api/v1/sessions",
                json={"trainee_id": "T4", "scenario_id": scenario["scenario_id"]})
    # Never completed, so it must not appear in history.
    history = client.get("/api/v1/trainees/T4/sessions").json()
    assert history == []


def test_session_history_unknown_trainee_is_404(client) -> None:
    assert client.get("/api/v1/trainees/NOBODY/sessions").status_code == 404


def test_unit_performance_aggregates_the_unit(client) -> None:
    _play(client, _scenario(client, 6), "T5", unit="ALPHA-1")
    _play(client, _scenario(client, 7), "T6", unit="ALPHA-1")
    body = client.get("/api/v1/units/ALPHA-1/performance").json()
    assert body["unit"] == "ALPHA-1"
    assert body["session_count"] == 2
    # Two distinct trainees contributed.
    assert body["trainee_count"] == 2


def test_unit_performance_is_scoped_to_that_unit(client) -> None:
    _play(client, _scenario(client, 8), "T7", unit="ALPHA-1")
    _play(client, _scenario(client, 9), "T8", unit="BRAVO-2")
    alpha = client.get("/api/v1/units/ALPHA-1/performance").json()
    assert alpha["session_count"] == 1
    bravo = client.get("/api/v1/units/BRAVO-2/performance").json()
    assert bravo["session_count"] == 1


def test_unit_performance_unknown_unit_is_404(client) -> None:
    assert client.get("/api/v1/units/GHOST/performance").status_code == 404