"""Phase 4 DoD: the five demo_validation.md questions answer YES via tests."""

from __future__ import annotations

from app.schemas.events import EventCreateRequest
from app.schemas.scenario import Scenario
from app.services.scoring import score


def _generate(client, seed: int):
    return client.post(
        "/api/v1/scenarios/generate",
        json={"difficulty": 3, "environment": "urban", "time_of_day": "day",
              "threat_count": 1, "seed": seed},
    )


def _scenario_from(body: dict) -> Scenario:
    return Scenario(**body)


def _events_for(body: dict) -> list[EventCreateRequest]:
    threat = body["threats"][0]
    base = int(round(threat["spawn_time"] * 1000)) + 500
    return [
        EventCreateRequest(type="THREAT_DETECTED", timestamp_ms=base, threat_id=threat["id"]),
        EventCreateRequest(type="CLASSIFICATION_SUBMITTED", timestamp_ms=base + 1000,
                           threat_id=threat["id"], payload={"label": threat["classification_label"]}),
        EventCreateRequest(type="RESPONSE_SUBMITTED", timestamp_ms=base + 2000,
                           threat_id=threat["id"], payload={"response": threat["expected_response"]}),
    ]


def test_q1_same_seed_reproduces_scenario(client) -> None:
    first = _generate(client, 12345).json()
    second = _generate(client, 12345).json()
    assert first == second


def test_q2_same_events_reproduce_score(client) -> None:
    body = _generate(client, 5).json()
    scenario = _scenario_from(body)
    events = _events_for(body)
    first = score("SES-A", scenario, events).model_dump(exclude={"session_id"})
    second = score("SES-B", scenario, events).model_dump(exclude={"session_id"})
    assert first == second
    no_events = score("SES-C", scenario, []).model_dump(exclude={"session_id"})
    assert no_events != first


def test_q3_missed_threat_appears_in_aar(client) -> None:
    body = _generate(client, 7).json()
    session = client.post(
        "/api/v1/sessions",
        json={"trainee_id": "TRAIN-Q3", "scenario_id": body["scenario_id"]},
    ).json()
    client.post(f"/api/v1/sessions/{session['session_id']}/complete")
    aar = client.get(f"/api/v1/sessions/{session['session_id']}/aar").json()
    assert any(m["kind"] == "missed_threat" for m in aar["mistakes"])


def test_q4_performance_compares_across_sessions(client) -> None:
    for seed in (20, 21):
        body = _generate(client, seed).json()
        session = client.post(
            "/api/v1/sessions",
            json={"trainee_id": "TRAIN-Q4", "scenario_id": body["scenario_id"]},
        ).json()
        for event in _events_for(body):
            client.post(f"/api/v1/sessions/{session['session_id']}/events", json=event.model_dump(mode="json"))
        client.post(f"/api/v1/sessions/{session['session_id']}/complete")
    profile = client.get("/api/v1/trainees/TRAIN-Q4/performance").json()
    assert profile["session_count"] == 2
    assert profile["detection_accuracy"] == 100.0


def test_q5_recommendation_explains_itself(client) -> None:
    for seed in (30, 31, 32):
        body = _generate(client, seed).json()
        session = client.post(
            "/api/v1/sessions",
            json={"trainee_id": "TRAIN-Q5", "scenario_id": body["scenario_id"]},
        ).json()
        for event in _events_for(body):
            client.post(f"/api/v1/sessions/{session['session_id']}/events", json=event.model_dump(mode="json"))
        client.post(f"/api/v1/sessions/{session['session_id']}/complete")
    recommendation = client.post(
        "/api/v1/training/recommend", json={"trainee_id": "TRAIN-Q5"}
    ).json()
    assert recommendation["reason"]
    assert any(char.isdigit() for char in recommendation["reason"])
