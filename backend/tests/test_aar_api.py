from __future__ import annotations


def _generate(client, seed: int = 12345):
    body = client.post(
        "/api/v1/scenarios/generate",
        json={"difficulty": 3, "environment": "rural", "time_of_day": "day",
              "threat_count": 1, "seed": seed},
    ).json()
    return body


def test_aar_requires_completed_session(client) -> None:
    scenario = _generate(client)
    session = client.post(
        "/api/v1/sessions",
        json={"trainee_id": "TRAIN-001", "scenario_id": scenario["scenario_id"]},
    ).json()
    response = client.get(f"/api/v1/sessions/{session['session_id']}/aar")
    assert response.status_code == 404


def test_aar_unknown_session_is_404(client) -> None:
    assert client.get("/api/v1/sessions/SES-NOPE/aar").status_code == 404


def test_aar_reports_missed_threat_after_completion(client) -> None:
    scenario = _generate(client)
    session = client.post(
        "/api/v1/sessions",
        json={"trainee_id": "TRAIN-001", "scenario_id": scenario["scenario_id"]},
    ).json()
    sid = session["session_id"]
    # finish with no events -> everything missed
    completed = client.post(f"/api/v1/sessions/{sid}/complete")
    assert completed.status_code == 200

    aar = client.get(f"/api/v1/sessions/{sid}/aar")
    assert aar.status_code == 200
    body = aar.json()
    assert body["session_id"] == sid
    assert body["scenario_id"] == scenario["scenario_id"]
    assert body["scores"]["final_score"] == completed.json()["final_score"]
    assert any(m["kind"] == "missed_threat" for m in body["mistakes"])
    assert body["summary"]  # template narrator produced text
    assert body["recommendation"]
    # Completion derives an explicit THREAT_MISSED event per undetected
    # threat, so the timeline shows the miss instead of silence.
    missed = [e for e in body["timeline"] if e["type"] == "THREAT_MISSED"]
    assert len(missed) == 1
    assert missed[0]["threat_id"] == scenario["threats"][0]["id"]


def test_aar_reveals_ground_truth_only_post_completion(client) -> None:
    scenario = _generate(client)
    session = client.post(
        "/api/v1/sessions",
        json={"trainee_id": "TRAIN-001", "scenario_id": scenario["scenario_id"]},
    ).json()
    sid = session["session_id"]
    client.post(f"/api/v1/sessions/{sid}/complete")
    body = client.get(f"/api/v1/sessions/{sid}/aar").json()
    assert body["ground_truth"] == [
        {
            "threat_id": threat["id"],
            "classification_label": threat["classification_label"],
            "expected_response": threat["expected_response"],
        }
        for threat in scenario["threats"]
    ]


def test_aar_timeline_is_ordered(client) -> None:
    scenario = _generate(client)
    threat_id = scenario["threats"][0]["id"]
    base = int(round(scenario["threats"][0]["spawn_time"] * 1000)) + 1000
    session = client.post(
        "/api/v1/sessions",
        json={"trainee_id": "TRAIN-001", "scenario_id": scenario["scenario_id"]},
    ).json()
    sid = session["session_id"]
    for payload in (
        {"type": "THREAT_DETECTED", "timestamp_ms": base, "threat_id": threat_id},
        {"type": "CLASSIFICATION_SUBMITTED", "timestamp_ms": base + 300, "threat_id": threat_id,
         "payload": {"label": scenario["threats"][0]["classification_label"]}},
        {"type": "RESPONSE_SUBMITTED", "timestamp_ms": base + 600, "threat_id": threat_id,
         "payload": {"response": scenario["threats"][0]["expected_response"]}},
    ):
        assert client.post(f"/api/v1/sessions/{sid}/events", json=payload).status_code == 201
    client.post(f"/api/v1/sessions/{sid}/complete")

    body = client.get(f"/api/v1/sessions/{sid}/aar").json()
    timestamps = [event["timestamp_ms"] for event in body["timeline"]]
    assert timestamps == sorted(timestamps)
