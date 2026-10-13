from __future__ import annotations

from app.db.models import (
    EventRow,
    ScenarioRow,
    ScoreRow,
    SessionRow,
    event_row_to_request,
)
from app.services.scoring import score

# Independently verified vector for seed=4242, threat_count=2, one threat
# fully handled (DETECTED@spawn+1000 -> correct CLASSIFICATION@spawn+2000 ->
# correct RESPONSE@spawn+3000) and 0 false alarms: 30x(1/2), 30x(1/2), 25x(1/2),
# and timing 2000ms -> 15 points / 2 threats = 7.5.
EXPECTED_DETECTION_SCORE = 15.0
EXPECTED_CLASSIFICATION_SCORE = 15.0
EXPECTED_RESPONSE_SCORE = 12.5
EXPECTED_TIMING_SCORE = 7.5
EXPECTED_PENALTY = 0.0
EXPECTED_FINAL_SCORE = 50.0


def _generate(client, seed: int) -> dict:
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


def test_full_session_lifecycle_is_deterministic(client, db_session) -> None:
    scenario = _generate(client, seed=4242)
    created = client.post(
        "/api/v1/sessions",
        json={"trainee_id": "TRAIN-042", "scenario_id": scenario["scenario_id"]},
    )
    assert created.status_code == 201
    session_id = created.json()["session_id"]

    threat = scenario["threats"][0]
    base = int(round(threat["spawn_time"] * 1000)) + 1000
    events = [
        {"type": "THREAT_DETECTED", "timestamp_ms": base, "threat_id": threat["id"]},
        {
            "type": "CLASSIFICATION_SUBMITTED",
            "timestamp_ms": base + 1000,
            "threat_id": threat["id"],
            "payload": {"label": threat["classification_label"]},
        },
        {
            "type": "RESPONSE_SUBMITTED",
            "timestamp_ms": base + 2000,
            "threat_id": threat["id"],
            "payload": {"response": threat["expected_response"]},
        },
    ]
    for event in events:
        assert (
            client.post(
                f"/api/v1/sessions/{session_id}/events", json=event
            ).status_code
            == 201
        )

    completed = client.post(f"/api/v1/sessions/{session_id}/complete")
    assert completed.status_code == 200
    assert completed.json()["final_score"] == EXPECTED_FINAL_SCORE

    session_row = db_session.get(SessionRow, session_id)
    assert session_row is not None
    assert session_row.status == "completed"

    score_row = db_session.get(ScoreRow, session_id)
    assert score_row is not None
    assert score_row.detection_score == EXPECTED_DETECTION_SCORE
    assert score_row.classification_score == EXPECTED_CLASSIFICATION_SCORE
    assert score_row.response_score == EXPECTED_RESPONSE_SCORE
    assert score_row.timing_score == EXPECTED_TIMING_SCORE
    assert score_row.penalty == EXPECTED_PENALTY
    assert score_row.final_score == EXPECTED_FINAL_SCORE

    # Recompute independently from the persisted scenario + events; the
    # algorithm itself must reproduce the pinned vector above.
    scenario_row = db_session.get(ScenarioRow, scenario["scenario_id"])
    event_rows = (
        db_session.query(EventRow)
        .filter(EventRow.session_id == session_id)
        .order_by(EventRow.timestamp_ms, EventRow.event_id)
        .all()
    )
    recomputed = score(
        session_id,
        scenario_row.to_schema(),
        [event_row_to_request(row) for row in event_rows],
    )
    assert recomputed.final_score == EXPECTED_FINAL_SCORE
