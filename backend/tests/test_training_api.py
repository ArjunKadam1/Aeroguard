from __future__ import annotations


def _scenario(client, seed: int, difficulty: int = 3):
    return client.post(
        "/api/v1/scenarios/generate",
        json={"difficulty": difficulty, "environment": "rural", "time_of_day": "night",
              "threat_count": 1, "seed": seed},
    ).json()


def _play(client, scenario, *, correct: bool, trainee_id: str = "TRAIN-001") -> str:
    threat = scenario["threats"][0]
    session = client.post(
        "/api/v1/sessions",
        json={"trainee_id": trainee_id, "scenario_id": scenario["scenario_id"]},
    ).json()
    sid = session["session_id"]
    if correct:
        base = int(round(threat["spawn_time"] * 1000)) + 500
        events = [
            {"type": "THREAT_DETECTED", "timestamp_ms": base, "threat_id": threat["id"]},
            {"type": "CLASSIFICATION_SUBMITTED", "timestamp_ms": base + 1000, "threat_id": threat["id"],
             "payload": {"label": threat["classification_label"]}},
            {"type": "RESPONSE_SUBMITTED", "timestamp_ms": base + 2000, "threat_id": threat["id"],
             "payload": {"response": threat["expected_response"]}},
        ]
        for event in events:
            client.post(f"/api/v1/sessions/{sid}/events", json=event)
    client.post(f"/api/v1/sessions/{sid}/complete")
    return sid


def test_performance_unknown_trainee_is_404(client) -> None:
    assert client.get("/api/v1/trainees/TRAIN-NONE/performance").status_code == 404


def test_performance_aggregates_completed_sessions(client) -> None:
    _play(client, _scenario(client, 1), correct=True)
    _play(client, _scenario(client, 2), correct=True)
    response = client.get("/api/v1/trainees/TRAIN-001/performance")
    assert response.status_code == 200
    body = response.json()
    assert body["trainee_id"] == "TRAIN-001"
    assert body["session_count"] == 2
    assert body["detection_accuracy"] == 100.0
    assert body["night_score"] == 100.0


def test_recommend_unknown_trainee_is_404(client) -> None:
    assert client.post("/api/v1/training/recommend", json={"trainee_id": "TRAIN-NONE"}).status_code == 404


def test_recommend_invalid_body_is_422(client) -> None:
    assert client.post("/api/v1/training/recommend", json={}).status_code == 422


def test_recommend_defaults_for_active_only_trainee(client) -> None:
    scenario = _scenario(client, 3)
    client.post(
        "/api/v1/sessions",
        json={"trainee_id": "TRAIN-ACT", "scenario_id": scenario["scenario_id"]},
    )
    response = client.post("/api/v1/training/recommend", json={"trainee_id": "TRAIN-ACT"})
    assert response.status_code == 200
    body = response.json()
    assert body["recommended_difficulty"] == 1
    assert "no completed sessions" in body["reason"].lower()


def test_recommend_increases_and_persists_level(client) -> None:
    for seed in (10, 11, 12):
        _play(client, _scenario(client, seed, difficulty=3), correct=True)
    first = client.post("/api/v1/training/recommend", json={"trainee_id": "TRAIN-001"}).json()
    # Level is seeded from the scenario difficulty actually played (3), then +1.
    assert first["recommended_difficulty"] == 4
    assert "increasing" in first["reason"].lower()
    # level was persisted
    assert client.get("/api/v1/trainees/TRAIN-001/performance").json()["current_level"] == 4


def test_recommend_seeds_level_from_played_difficulty(client) -> None:
    """A trainee who just played difficulty 6 must not be told they are at 1."""
    for seed in (20, 21, 22):
        _play(client, _scenario(client, seed, difficulty=6), correct=True, trainee_id="TRAIN-002")
    body = client.post("/api/v1/training/recommend", json={"trainee_id": "TRAIN-002"}).json()
    assert body["recommended_difficulty"] == 7
    assert "from 6 to 7" in body["reason"]


def test_recommend_hold_reason_does_not_claim_a_fixed_score_band(client) -> None:
    """A single 100.0 session holds the level; the reason must not say (60-89)."""
    _play(client, _scenario(client, 31, difficulty=4), correct=True, trainee_id="TRAIN-003")
    body = client.post("/api/v1/training/recommend", json={"trainee_id": "TRAIN-003"}).json()
    assert body["recommended_difficulty"] == 4
    assert "100.0" in body["reason"]
    assert "60-89" not in body["reason"]


def _play_slow_acquisition(client, seed: int, trainee_id: str, sensor: str | None) -> None:
    scenario = _scenario(client, seed, difficulty=3)
    threat = scenario["threats"][0]
    session = client.post(
        "/api/v1/sessions",
        json={"trainee_id": trainee_id, "scenario_id": scenario["scenario_id"]},
    ).json()
    sid = session["session_id"]
    base = int(round(threat["spawn_time"] * 1000)) + 12000
    detect_payload = {"sensor": sensor} if sensor else {}
    events = [
        {"type": "THREAT_DETECTED", "timestamp_ms": base, "threat_id": threat["id"],
         "payload": detect_payload},
        {"type": "CLASSIFICATION_SUBMITTED", "timestamp_ms": base + 1000,
         "threat_id": threat["id"], "payload": {"label": threat["classification_label"]}},
        {"type": "RESPONSE_SUBMITTED", "timestamp_ms": base + 2000,
         "threat_id": threat["id"], "payload": {"response": threat["expected_response"]}},
    ]
    for event in events:
        assert client.post(f"/api/v1/sessions/{sid}/events", json=event).status_code == 201
    client.post(f"/api/v1/sessions/{sid}/complete")


def test_recommend_cites_acquisition_lag(client) -> None:
    _play_slow_acquisition(client, seed=40, trainee_id="TRAIN-LAG", sensor="visual")
    body = client.post("/api/v1/training/recommend", json={"trainee_id": "TRAIN-LAG"}).json()
    assert "acquisition lag" in body["reason"].lower()


def test_recommend_cites_radar_reliance(client) -> None:
    _play_slow_acquisition(client, seed=41, trainee_id="TRAIN-RADAR", sensor="radar")
    body = client.post("/api/v1/training/recommend", json={"trainee_id": "TRAIN-RADAR"}).json()
    reason = body["reason"].lower()
    assert "radar reliance" in reason
    assert "100%" in body["reason"]
