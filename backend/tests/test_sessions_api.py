from __future__ import annotations


def _create_scenario(client, seed: int = 12345) -> str:
    return _generate_body(client, seed)["scenario_id"]


def _generate_body(client, seed: int = 12345) -> dict:
    response = client.post(
        "/api/v1/scenarios/generate",
        json={
            "difficulty": 6,
            "environment": "urban",
            "time_of_day": "night",
            "threat_count": 2,
            "seed": seed,
        },
    )
    assert response.status_code == 200
    return response.json()


def _spawn_ms(scenario: dict, threat_id: str = "T01") -> int:
    for threat in scenario["threats"]:
        if threat["id"] == threat_id:
            return int(round(threat["spawn_time"] * 1000))
    raise AssertionError(f"unknown threat in fixture: {threat_id}")


def test_create_session_returns_active_session(client) -> None:
    scenario_id = _create_scenario(client)
    response = client.post(
        "/api/v1/sessions",
        json={"trainee_id": "TRAIN-001", "scenario_id": scenario_id},
    )
    assert response.status_code == 201
    body = response.json()
    assert body["session_id"].startswith("SES-")
    assert body["status"] == "active"


def test_create_session_unknown_scenario_returns_404(client) -> None:
    response = client.post(
        "/api/v1/sessions",
        json={"trainee_id": "TRAIN-001", "scenario_id": "SCN-DOESNOTEXIST"},
    )
    assert response.status_code == 404


def test_create_session_invalid_body_returns_422(client) -> None:
    response = client.post("/api/v1/sessions", json={"trainee_id": "TRAIN-001"})
    assert response.status_code == 422


def test_submit_event_returns_event_id(client) -> None:
    scenario = _generate_body(client)
    session_id = client.post(
        "/api/v1/sessions",
        json={"trainee_id": "TRAIN-001", "scenario_id": scenario["scenario_id"]},
    ).json()["session_id"]
    response = client.post(
        f"/api/v1/sessions/{session_id}/events",
        json={"type": "THREAT_DETECTED", "timestamp_ms": _spawn_ms(scenario) + 1000, "threat_id": "T01"},
    )
    assert response.status_code == 201
    body = response.json()
    assert body["accepted"] is True
    assert body["event_id"].startswith("EVT-")


def test_submit_event_unknown_session_returns_404(client) -> None:
    response = client.post(
        "/api/v1/sessions/SES-NOPE/events",
        json={"type": "THREAT_DETECTED", "timestamp_ms": 1000, "threat_id": "T01"},
    )
    assert response.status_code == 404
    assert response.json()["detail"] == "unknown session_id: SES-NOPE"


def test_submit_event_unknown_threat_returns_422(client) -> None:
    scenario_id = _create_scenario(client)
    session_id = client.post(
        "/api/v1/sessions",
        json={"trainee_id": "TRAIN-001", "scenario_id": scenario_id},
    ).json()["session_id"]
    response = client.post(
        f"/api/v1/sessions/{session_id}/events",
        json={"type": "THREAT_DETECTED", "timestamp_ms": 1000, "threat_id": "T99"},
    )
    assert response.status_code == 422


def test_submit_event_invalid_type_returns_422(client) -> None:
    scenario_id = _create_scenario(client)
    session_id = client.post(
        "/api/v1/sessions",
        json={"trainee_id": "TRAIN-001", "scenario_id": scenario_id},
    ).json()["session_id"]
    response = client.post(
        f"/api/v1/sessions/{session_id}/events",
        json={"type": "NOT_A_TYPE", "timestamp_ms": 1000},
    )
    assert response.status_code == 422


def test_event_ids_are_globally_unique_across_sessions(client) -> None:
    scenario = _generate_body(client)
    first_session = client.post(
        "/api/v1/sessions",
        json={"trainee_id": "TRAIN-001", "scenario_id": scenario["scenario_id"]},
    ).json()["session_id"]
    second_session = client.post(
        "/api/v1/sessions",
        json={"trainee_id": "TRAIN-002", "scenario_id": scenario["scenario_id"]},
    ).json()["session_id"]

    first_event = client.post(
        f"/api/v1/sessions/{first_session}/events",
        json={"type": "THREAT_DETECTED", "timestamp_ms": _spawn_ms(scenario) + 1000, "threat_id": "T01"},
    )
    second_event = client.post(
        f"/api/v1/sessions/{second_session}/events",
        json={"type": "THREAT_DETECTED", "timestamp_ms": _spawn_ms(scenario) + 2000, "threat_id": "T01"},
    )

    assert first_event.status_code == 201
    assert second_event.status_code == 201
    first_id = first_event.json()["event_id"]
    second_id = second_event.json()["event_id"]
    assert first_id.startswith("EVT-")
    assert second_id.startswith("EVT-")
    assert first_id != second_id


def _complete_flow(client, seed: int = 12345) -> str:
    scenario = _generate_body(client, seed)
    session_id = client.post(
        "/api/v1/sessions",
        json={"trainee_id": "TRAIN-001", "scenario_id": scenario["scenario_id"]},
    ).json()["session_id"]
    base = _spawn_ms(scenario)
    events = [
        {"type": "THREAT_DETECTED", "timestamp_ms": base + 1000, "threat_id": "T01"},
        {"type": "CLASSIFICATION_SUBMITTED", "timestamp_ms": base + 2000, "threat_id": "T01", "payload": {"label": "hostile"}},
        {"type": "RESPONSE_SUBMITTED", "timestamp_ms": base + 3000, "threat_id": "T01", "payload": {"response": "hold"}},
    ]
    for event in events:
        assert client.post(f"/api/v1/sessions/{session_id}/events", json=event).status_code == 201
    return session_id


def test_complete_returns_server_side_score(client, db_session) -> None:
    from app.db.models import ScoreRow, SessionRow

    session_id = _complete_flow(client)
    response = client.post(f"/api/v1/sessions/{session_id}/complete")
    assert response.status_code == 200
    body = response.json()
    assert body["session_id"] == session_id
    assert body["aar_available"] is True
    assert body["scoring_version"] == 2
    assert 0 <= body["final_score"] <= 100

    row = db_session.get(ScoreRow, session_id)
    assert row is not None
    assert row.final_score == body["final_score"]
    assert db_session.get(SessionRow, session_id).status == "completed"


def test_complete_preserves_historical_v1_score(client, db_session) -> None:
    from app.db.models import ScoreRow

    session_id = _complete_flow(client, seed=999)
    client.post(f"/api/v1/sessions/{session_id}/complete")
    # Simulate a session originally scored under v1: historical rows keep
    # their version and values, and re-completion returns them untouched.
    row = db_session.get(ScoreRow, session_id)
    assert row is not None
    row.scoring_version = 1
    row.final_score = 61.5
    db_session.commit()

    reread = client.post(f"/api/v1/sessions/{session_id}/complete").json()
    assert reread["scoring_version"] == 1
    assert reread["final_score"] == 61.5


def test_complete_is_idempotent(client, db_session) -> None:
    from app.db.models import ScoreRow

    session_id = _complete_flow(client, seed=777)
    first = client.post(f"/api/v1/sessions/{session_id}/complete").json()
    second = client.post(f"/api/v1/sessions/{session_id}/complete").json()
    assert first == second
    assert db_session.query(ScoreRow).filter(ScoreRow.session_id == session_id).count() == 1


def test_complete_unknown_session_returns_404(client) -> None:
    response = client.post("/api/v1/sessions/SES-NOPE/complete")
    assert response.status_code == 404
    assert response.json()["detail"] == "unknown session_id: SES-NOPE"


def test_events_rejected_after_completion(client) -> None:
    session_id = _complete_flow(client, seed=888)
    client.post(f"/api/v1/sessions/{session_id}/complete")
    response = client.post(
        f"/api/v1/sessions/{session_id}/events",
        json={"type": "THREAT_DETECTED", "timestamp_ms": 5000, "threat_id": "T01"},
    )
    assert response.status_code == 422


def _false_alarm_flow(client, false_alarm_count: int) -> str:
    scenario_id = client.post(
        "/api/v1/scenarios/generate",
        json={
            "difficulty": 3,
            "environment": "urban",
            "time_of_day": "day",
            "threat_count": 1,
            "seed": 4242,
        },
    ).json()["scenario_id"]
    session_id = client.post(
        "/api/v1/sessions",
        json={"trainee_id": "TRAIN-001", "scenario_id": scenario_id},
    ).json()["session_id"]
    for i in range(false_alarm_count):
        response = client.post(
            f"/api/v1/sessions/{session_id}/events",
            json={"type": "FALSE_ALARM", "timestamp_ms": 500 + 100 * i},
        )
        assert response.status_code == 201
    return session_id


def test_single_false_alarm_penalizes_five_points(client, db_session) -> None:
    from app.db.models import ScoreRow

    session_id = _false_alarm_flow(client, false_alarm_count=1)
    body = client.post(f"/api/v1/sessions/{session_id}/complete").json()
    assert body["final_score"] == 0.0

    row = db_session.get(ScoreRow, session_id)
    assert row is not None
    assert row.penalty == 5.0
    assert row.final_score == 0.0


def test_two_false_alarms_accumulate_ten_point_penalty(client, db_session) -> None:
    from app.db.models import ScoreRow

    session_id = _false_alarm_flow(client, false_alarm_count=2)
    body = client.post(f"/api/v1/sessions/{session_id}/complete").json()
    assert body["final_score"] == 0.0

    row = db_session.get(ScoreRow, session_id)
    assert row is not None
    assert row.penalty == 10.0
    assert row.final_score == 0.0


def test_complete_returns_score_breakdown(client) -> None:
    scenario_id = _create_scenario(client)
    session_id = client.post(
        "/api/v1/sessions",
        json={"trainee_id": "TRAIN-001", "scenario_id": scenario_id},
    ).json()["session_id"]
    response = client.post(f"/api/v1/sessions/{session_id}/complete")
    assert response.status_code == 200
    body = response.json()
    for key in (
        "detection_score",
        "classification_score",
        "response_score",
        "timing_score",
        "penalty",
        "final_score",
        "scoring_version",
    ):
        assert key in body, key
    assert body["detection_score"] == 0.0
    assert body["final_score"] == 0.0
