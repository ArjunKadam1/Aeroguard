"""Scripted scenarios: exact, repeatable, instructor-authored training cases."""

from __future__ import annotations


def test_list_scripted_returns_fixtures(client) -> None:
    response = client.get("/api/v1/scenarios/scripted")
    assert response.status_code == 200
    keys = {item["key"]: item for item in response.json()}
    assert "first-contact-day" in keys
    assert "night-pair-degraded" in keys
    first = keys["first-contact-day"]
    assert first["title"] == "First Contact"
    assert first["difficulty"] == 1
    assert first["threat_count"] == 1


def test_create_scripted_is_deterministic(client) -> None:
    first = client.post(
        "/api/v1/scenarios/scripted", json={"scenario_key": "first-contact-day"}
    )
    second = client.post(
        "/api/v1/scenarios/scripted", json={"scenario_key": "first-contact-day"}
    )
    assert first.status_code == 200
    assert second.status_code == 200
    assert first.json() == second.json()
    assert first.json()["scenario_id"] == "SCRIPT-FIRST-CONTACT"
    assert first.json()["generator_version"] == "scripted-1.0"


def test_create_scripted_unknown_key_is_404(client) -> None:
    response = client.post(
        "/api/v1/scenarios/scripted", json={"scenario_key": "no-such-scenario"}
    )
    assert response.status_code == 404


def test_create_scripted_rejects_path_traversal_key(client) -> None:
    response = client.post(
        "/api/v1/scenarios/scripted", json={"scenario_key": "../secret"}
    )
    assert response.status_code == 404


def test_scripted_view_has_cues_and_no_answers(client) -> None:
    scenario = client.post(
        "/api/v1/scenarios/scripted", json={"scenario_key": "first-contact-day"}
    ).json()
    view = client.get(f"/api/v1/scenarios/{scenario['scenario_id']}/view").json()
    assert "classification_label" not in str(view)
    assert "expected_response" not in str(view)
    assert view["threats"][0]["behavior"] == "steady-transit"
    assert view["threats"][0]["cue_clear"] is True


def test_scripted_perfect_play_scores_full_marks(client) -> None:
    scenario = client.post(
        "/api/v1/scenarios/scripted", json={"scenario_key": "first-contact-day"}
    ).json()
    threat = scenario["threats"][0]
    session_id = client.post(
        "/api/v1/sessions",
        json={"trainee_id": "TRAIN-SCRIPT", "scenario_id": scenario["scenario_id"]},
    ).json()["session_id"]
    base = int(round(threat["spawn_time"] * 1000)) + 1000
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
        assert client.post(f"/api/v1/sessions/{session_id}/events", json=event).status_code == 201
    result = client.post(f"/api/v1/sessions/{session_id}/complete").json()
    assert result["final_score"] == 100.0
    assert result["scoring_version"] == 2
