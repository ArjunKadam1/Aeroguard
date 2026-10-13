"""Server-side event validation: monotonic time, spawn timing, stage order."""

from __future__ import annotations


def _setup(client, seed: int = 12345) -> tuple[str, dict]:
    scenario = client.post(
        "/api/v1/scenarios/generate",
        json={
            "difficulty": 6,
            "environment": "urban",
            "time_of_day": "night",
            "threat_count": 2,
            "seed": seed,
        },
    ).json()
    session_id = client.post(
        "/api/v1/sessions",
        json={"trainee_id": "TRAIN-001", "scenario_id": scenario["scenario_id"]},
    ).json()["session_id"]
    return session_id, scenario


def _post(client, session_id: str, event: dict):
    return client.post(f"/api/v1/sessions/{session_id}/events", json=event)


def _spawn_ms(scenario: dict, threat_id: str) -> int:
    for threat in scenario["threats"]:
        if threat["id"] == threat_id:
            return int(round(threat["spawn_time"] * 1000))
    raise AssertionError(f"unknown threat in fixture: {threat_id}")


def test_detection_before_spawn_is_rejected(client) -> None:
    session_id, scenario = _setup(client)
    response = _post(client, session_id, {
        "type": "THREAT_DETECTED", "timestamp_ms": 0, "threat_id": "T02",
    })
    assert response.status_code == 422
    assert "predates spawn" in response.json()["detail"]


def test_classification_without_detection_is_rejected(client) -> None:
    session_id, scenario = _setup(client)
    base = _spawn_ms(scenario, "T01") + 1000
    response = _post(client, session_id, {
        "type": "CLASSIFICATION_SUBMITTED", "timestamp_ms": base,
        "threat_id": "T01", "payload": {"label": "hostile"},
    })
    assert response.status_code == 422
    assert "prior detection" in response.json()["detail"]


def test_response_without_classification_is_rejected(client) -> None:
    session_id, scenario = _setup(client)
    base = _spawn_ms(scenario, "T01") + 1000
    assert _post(client, session_id, {
        "type": "THREAT_DETECTED", "timestamp_ms": base, "threat_id": "T01",
    }).status_code == 201
    response = _post(client, session_id, {
        "type": "RESPONSE_SUBMITTED", "timestamp_ms": base + 1000,
        "threat_id": "T01", "payload": {"response": "hold"},
    })
    assert response.status_code == 422
    assert "prior classification" in response.json()["detail"]


def test_older_timestamp_than_last_event_is_rejected(client) -> None:
    session_id, scenario = _setup(client)
    base = _spawn_ms(scenario, "T01") + 5000
    assert _post(client, session_id, {
        "type": "THREAT_DETECTED", "timestamp_ms": base, "threat_id": "T01",
    }).status_code == 201
    response = _post(client, session_id, {
        "type": "FALSE_ALARM", "timestamp_ms": base - 1,
    })
    assert response.status_code == 422
    assert "older than the last recorded event" in response.json()["detail"]


def test_coherent_stream_is_accepted(client) -> None:
    session_id, scenario = _setup(client)
    threat = scenario["threats"][0]
    base = _spawn_ms(scenario, threat["id"]) + 1000
    events = [
        {"type": "THREAT_DETECTED", "timestamp_ms": base, "threat_id": threat["id"]},
        {"type": "CLASSIFICATION_SUBMITTED", "timestamp_ms": base + 1000,
         "threat_id": threat["id"],
         "payload": {"label": threat["classification_label"]}},
        {"type": "RESPONSE_SUBMITTED", "timestamp_ms": base + 2000,
         "threat_id": threat["id"],
         "payload": {"response": threat["expected_response"]}},
    ]
    for event in events:
        assert _post(client, session_id, event).status_code == 201
