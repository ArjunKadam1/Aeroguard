"""Phase 5 DoD: anti-repetition, visual-only score invariance, condition metrics."""

from __future__ import annotations

import itertools

from app.schemas.events import EventCreateRequest
from app.schemas.scenario import (
    Environment,
    Scenario,
    ScenarioGenerateRequest,
    TimeOfDay,
    Visibility,
)
from app.services.anti_repetition import RecentConfigTracker
from app.services.scenario_generator import (
    GENERATOR_VERSION,
    compute_difficulty,
    generate_scenario,
    sensor_factor,
)
from app.services.scoring import score


def _generate(client, seed: int | None = None, difficulty: int = 6,
              environment: str = "urban", time_of_day: str = "night"):
    body = {"difficulty": difficulty, "environment": environment, "time_of_day": time_of_day,
            "threat_count": 2}
    if seed is not None:
        body["seed"] = seed
    return client.post("/api/v1/scenarios/generate", json=body)


def test_dod_10_consecutive_scenarios_show_no_repeated_configuration(client) -> None:
    """DoD: 10 consecutive (unpinned) generations never repeat a configuration."""
    signatures = set()
    for _ in range(10):
        scenario = Scenario(**_generate(client).json())
        signatures.add(RecentConfigTracker.signature(scenario))
    assert len(signatures) == 10, "anti-repetition window returned a repeated configuration"


def _visual_variant(scenario: Scenario, **overrides) -> Scenario:
    return scenario.model_copy(update=overrides)


def test_dod_visual_only_changes_never_change_the_score() -> None:
    """DoD: fog/lighting-style visual fields are not inputs to scoring."""
    base = Scenario(
        scenario_id="SCN-000001", seed=1, generator_version=GENERATOR_VERSION,
        difficulty=5, environment=Environment.urban, time_of_day=TimeOfDay.day,
        visibility=Visibility.clear, sensor_quality=0.9, duration_seconds=120.0,
        threats=[
            {
                "id": "T01", "classification_label": "hostile",
                "expected_response": "hold", "spawn_time": 10.0,
                "speed_class": "medium", "visibility_class": "clear",
            },
            {
                "id": "T02", "classification_label": "friendly",
                "expected_response": "monitor", "spawn_time": 40.0,
                "speed_class": "slow", "visibility_class": "clear",
            },
        ],
    )
    events = [
        EventCreateRequest(type="THREAT_DETECTED", timestamp_ms=11_000, threat_id="T01"),
        EventCreateRequest(type="CLASSIFICATION_SUBMITTED", timestamp_ms=13_000,
                           threat_id="T01", payload={"label": "hostile"}),
        EventCreateRequest(type="RESPONSE_SUBMITTED", timestamp_ms=15_000,
                           threat_id="T01", payload={"response": "hold"}),
        EventCreateRequest(type="THREAT_DETECTED", timestamp_ms=42_000, threat_id="T02"),
        EventCreateRequest(type="CLASSIFICATION_SUBMITTED", timestamp_ms=44_000,
                           threat_id="T02", payload={"label": "friendly"}),
        EventCreateRequest(type="RESPONSE_SUBMITTED", timestamp_ms=46_000,
                           threat_id="T02", payload={"response": "monitor"}),
    ]
    expected = score("SES-VIS", base, events).model_dump(exclude={"session_id"})

    variants = [
        _visual_variant(base, visibility=Visibility.poor),
        _visual_variant(base, visibility=Visibility.reduced),
        _visual_variant(base, sensor_quality=0.1),
        _visual_variant(base, time_of_day=TimeOfDay.night),
        _visual_variant(base, environment=Environment.rural),
        _visual_variant(base, visibility=Visibility.poor, sensor_quality=0.1,
                        time_of_day=TimeOfDay.night, environment=Environment.rural),
    ]
    for variant in variants:
        actual = score("SES-VIS", variant, events).model_dump(exclude={"session_id"})
        assert actual == expected, (
            f"visual-only change altered the score: visibility={variant.visibility}, "
            f"sensor={variant.sensor_quality}, time={variant.time_of_day}"
        )


def test_generator_covers_all_contract_dimensions() -> None:
    """Every contract dimension is reachable and difficulty stays explainable."""
    from app.services.scenario_generator import (
        BASE_DIFFICULTY,
        ENVIRONMENT_FACTOR,
        THREAT_COUNT_FACTOR,
        TIME_FACTOR,
    )

    seen_visibility: set[Visibility] = set()
    seen_sensor_bins: set[int] = set()
    for environment, time_of_day, threat_count in itertools.product(
        Environment, TimeOfDay, (1, 2, 3, 5)
    ):
        # Fixed part of the difficulty model for this combination; add a
        # residual of 3 (capped at the contract max of 10) so visibility,
        # sensor and timing allocations all have room to vary.
        fixed = (
            BASE_DIFFICULTY
            + THREAT_COUNT_FACTOR[threat_count]
            + ENVIRONMENT_FACTOR[environment]
            + TIME_FACTOR[time_of_day]
        )
        difficulty = min(fixed + 3, 10)
        request = ScenarioGenerateRequest(
            difficulty=difficulty, environment=environment, time_of_day=time_of_day,
            threat_count=threat_count,
        )
        for seed in range(50):
            scenario = generate_scenario(request, seed)
            seen_visibility.add(scenario.visibility)
            seen_sensor_bins.add(sensor_factor(scenario.sensor_quality))
            assert scenario.generator_version == GENERATOR_VERSION
            assert scenario.environment == environment
            assert scenario.time_of_day == time_of_day
            assert len(scenario.threats) == threat_count
            assert compute_difficulty(
                environment=scenario.environment,
                time_of_day=scenario.time_of_day,
                threat_count=len(scenario.threats),
                visibility=scenario.visibility,
                sensor_quality=scenario.sensor_quality,
                duration_seconds=scenario.duration_seconds,
            ) == difficulty

    # Across the sweep every visibility tier and sensor bin appears.
    assert seen_visibility == set(Visibility)
    assert seen_sensor_bins == {0, 1, 2}


def test_performance_exposes_condition_specific_metrics(client) -> None:
    scenario = _generate(client, seed=42, difficulty=6).json()
    session = client.post(
        "/api/v1/sessions",
        json={"trainee_id": "TRAIN-P5", "scenario_id": scenario["scenario_id"]},
    ).json()
    sid = session["session_id"]
    cursor = 0
    for threat in scenario["threats"]:
        # Decisions must follow the spawn and stay monotonic; the 2000ms
        # detect -> respond latency is preserved so timing scores are unchanged.
        base = max(cursor, int(round(threat["spawn_time"] * 1000)) + 500)
        for event in (
            {"type": "THREAT_DETECTED", "timestamp_ms": base, "threat_id": threat["id"]},
            {"type": "CLASSIFICATION_SUBMITTED", "timestamp_ms": base + 1000, "threat_id": threat["id"],
             "payload": {"label": threat["classification_label"]}},
            {"type": "RESPONSE_SUBMITTED", "timestamp_ms": base + 2000, "threat_id": threat["id"],
             "payload": {"response": threat["expected_response"]}},
        ):
            client.post(f"/api/v1/sessions/{sid}/events", json=event)
        cursor = base + 2000 + 100
    client.post(f"/api/v1/sessions/{sid}/complete")

    body = client.get("/api/v1/trainees/TRAIN-P5/performance").json()
    for field in (
        "urban_score", "rural_score", "clear_visibility_score",
        "reduced_visibility_score", "poor_visibility_score",
        "high_sensor_score", "medium_sensor_score", "low_sensor_score",
    ):
        assert field in body, f"missing condition metric: {field}"
    # The generated scenario is urban; the other environment has no sessions.
    assert body["urban_score"] == 100.0
    assert body["rural_score"] is None


def test_recommend_reason_cites_condition_weakness_from_history(client) -> None:
    """Recommendations are based on persisted condition-specific weaknesses."""
    # Play a strong rural session first, then a weak urban one.
    rural = _generate(client, seed=7, difficulty=6, environment="rural").json()
    rural_session = client.post(
        "/api/v1/sessions",
        json={"trainee_id": "TRAIN-P5R", "scenario_id": rural["scenario_id"]},
    ).json()
    threat = rural["threats"][0]
    base = int(round(threat["spawn_time"] * 1000)) + 500
    for event in (
        {"type": "THREAT_DETECTED", "timestamp_ms": base, "threat_id": threat["id"]},
        {"type": "CLASSIFICATION_SUBMITTED", "timestamp_ms": base + 1000, "threat_id": threat["id"],
         "payload": {"label": threat["classification_label"]}},
        {"type": "RESPONSE_SUBMITTED", "timestamp_ms": base + 2000, "threat_id": threat["id"],
         "payload": {"response": threat["expected_response"]}},
    ):
        client.post(f"/api/v1/sessions/{rural_session['session_id']}/events", json=event)
    client.post(f"/api/v1/sessions/{rural_session['session_id']}/complete")

    # A second (urban) session with no events scores 0, making urban the weak side.
    urban = client.post(
        "/api/v1/scenarios/generate",
        json={"difficulty": 6, "environment": "urban", "time_of_day": "night",
              "threat_count": 2, "seed": 99},
    ).json()
    urban_session = client.post(
        "/api/v1/sessions",
        json={"trainee_id": "TRAIN-P5R", "scenario_id": urban["scenario_id"]},
    ).json()
    client.post(f"/api/v1/sessions/{urban_session['session_id']}/complete")

    body = client.post("/api/v1/training/recommend", json={"trainee_id": "TRAIN-P5R"}).json()
    assert body["environment"] == "urban"
    assert "urban" in body["reason"].lower()
    assert body["recommended_difficulty"] >= 1


