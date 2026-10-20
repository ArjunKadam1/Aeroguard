import pytest

from app.schemas.scenario import ScenarioGenerateRequest
from app.services.scenario_generator import (
    LABEL_TO_RESPONSE,
    MIN_RESPONSE_SECONDS,
    SPAWN_WINDOW_RATIO,
    InfeasibleScenarioError,
    compute_difficulty,
    generate_scenario,
)


def _request(**overrides) -> ScenarioGenerateRequest:
    base = dict(difficulty=6, environment="urban", time_of_day="night", threat_count=2)
    base.update(overrides)
    return ScenarioGenerateRequest(**base)


def test_same_seed_produces_identical_scenario() -> None:
    assert generate_scenario(_request(), 12345) == generate_scenario(_request(), 12345)


def test_different_seed_changes_scenario() -> None:
    assert generate_scenario(_request(), 1) != generate_scenario(_request(), 2)


def test_threat_count_matches_request() -> None:
    assert len(generate_scenario(_request(threat_count=3), 999).threats) == 3


def test_threat_ids_are_ordered_and_unique() -> None:
    scenario = generate_scenario(_request(threat_count=3), 999)
    assert [t.id for t in scenario.threats] == ["T01", "T02", "T03"]


def test_spawn_times_within_duration() -> None:
    scenario = generate_scenario(_request(difficulty=8, threat_count=5), 777)
    for threat in scenario.threats:
        assert 0 <= threat.spawn_time < scenario.duration_seconds


def test_spawns_fall_in_the_opening_window() -> None:
    """Threats must appear early enough to be acted on before auto-finish."""
    for seed in range(200):
        scenario = generate_scenario(_request(difficulty=8, threat_count=5), seed)
        for threat in scenario.threats:
            assert threat.spawn_time <= scenario.duration_seconds * SPAWN_WINDOW_RATIO
            # Leaves room to detect, classify and respond before the timer ends.
            assert scenario.duration_seconds - threat.spawn_time >= MIN_RESPONSE_SECONDS - 0.05


def test_spawn_times_are_ordered_and_non_overlapping() -> None:
    scenario = generate_scenario(_request(difficulty=8, threat_count=5), 4242)
    spawns = [threat.spawn_time for threat in scenario.threats]
    assert spawns == sorted(spawns)
    slot = (scenario.duration_seconds * SPAWN_WINDOW_RATIO) / len(spawns)
    assert max(spawns) - min(spawns) >= slot * (len(spawns) - 1) * 0.5


def test_spawn_compression_does_not_break_determinism() -> None:
    first = generate_scenario(_request(difficulty=6, threat_count=3), 909)
    second = generate_scenario(_request(difficulty=6, threat_count=3), 909)
    assert [t.spawn_time for t in first.threats] == [t.spawn_time for t in second.threats]


def test_expected_response_matches_ground_truth_mapping() -> None:
    scenario = generate_scenario(_request(difficulty=8, threat_count=5), 42)
    for threat in scenario.threats:
        assert threat.expected_response == LABEL_TO_RESPONSE[threat.classification_label]


def test_difficulty_equals_requested_and_model() -> None:
    scenario = generate_scenario(_request(difficulty=8, threat_count=2), 7)
    assert scenario.difficulty == 8
    assert (
        compute_difficulty(
            environment=scenario.environment,
            time_of_day=scenario.time_of_day,
            threat_count=len(scenario.threats),
            visibility=scenario.visibility,
            sensor_quality=scenario.sensor_quality,
            duration_seconds=scenario.duration_seconds,
            threats=scenario.threats,
        )
        == 8
    )


def test_scenario_id_is_deterministic_and_formatted() -> None:
    assert generate_scenario(_request(), 123).scenario_id == "SCN-000123"


def test_generator_version_is_string_one_zero() -> None:
    assert generate_scenario(_request(), 5).generator_version == "1.0"


def test_infeasible_low_difficulty_raises() -> None:
    with pytest.raises(InfeasibleScenarioError):
        generate_scenario(
            _request(difficulty=1, environment="urban", time_of_day="night", threat_count=5),
            1,
        )


def test_infeasible_high_difficulty_raises() -> None:
    with pytest.raises(InfeasibleScenarioError):
        generate_scenario(
            _request(difficulty=10, environment="rural", time_of_day="day", threat_count=1),
            1,
        )


# --- Swarm grouping ---------------------------------------------------------


def _swarm_request(**overrides) -> ScenarioGenerateRequest:
    return _request(swarms=True, **overrides)


def test_swarms_are_off_by_default() -> None:
    scenario = generate_scenario(_request(difficulty=8, threat_count=5), 4242)
    assert all(t.swarm_id is None and t.swarm_index is None for t in scenario.threats)


def test_swarm_grouping_is_deterministic() -> None:
    assert generate_scenario(_swarm_request(difficulty=8, threat_count=5), 4242) == (
        generate_scenario(_swarm_request(difficulty=8, threat_count=5), 4242)
    )


def test_swarm_groups_are_coherent() -> None:
    scenario = generate_scenario(
        _swarm_request(difficulty=10, environment="rural", time_of_day="day", threat_count=5),
        777,
    )
    groups: dict[str, list] = {}
    for threat in scenario.threats:
        if threat.swarm_id is not None:
            groups.setdefault(threat.swarm_id, []).append(threat)
    assert groups, "opt-in swarms must produce at least one group"
    for members in groups.values():
        assert len(members) >= 2
        assert sorted(t.swarm_index for t in members) == list(range(len(members)))
        for field in (
            "classification_label",
            "expected_response",
            "flight_pattern",
            "spawn_time",
            "speed_class",
        ):
            assert len({getattr(t, field) for t in members}) == 1


def test_swarms_keep_count_conditions_and_difficulty_unchanged() -> None:
    for seed in range(30):
        plain = generate_scenario(_request(difficulty=8, threat_count=5), seed)
        shaped = generate_scenario(_swarm_request(difficulty=8, threat_count=5), seed)
        assert len(shaped.threats) == len(plain.threats) == 5
        assert shaped.visibility == plain.visibility
        assert shaped.sensor_quality == plain.sensor_quality
        assert shaped.duration_seconds == plain.duration_seconds
        assert shaped.difficulty == plain.difficulty == 8
        assert (
            compute_difficulty(
                environment=shaped.environment,
                time_of_day=shaped.time_of_day,
                threat_count=len(shaped.threats),
                visibility=shaped.visibility,
                sensor_quality=shaped.sensor_quality,
                duration_seconds=shaped.duration_seconds,
                threats=shaped.threats,
            )
            == 8
        )


def test_swarms_keep_conditions_with_a_motion_budget() -> None:
    # Residual 5 means demanding patterns can be drawn: group pattern sharing
    # must not change the motion cost or the condition allocation.
    for seed in range(30):
        plain = generate_scenario(
            _request(difficulty=10, environment="rural", time_of_day="day", threat_count=5),
            seed,
        )
        shaped = generate_scenario(
            _swarm_request(
                difficulty=10, environment="rural", time_of_day="day", threat_count=5
            ),
            seed,
        )
        assert shaped.visibility == plain.visibility
        assert shaped.sensor_quality == plain.sensor_quality
        assert shaped.duration_seconds == plain.duration_seconds
        assert compute_difficulty(
            environment=shaped.environment,
            time_of_day=shaped.time_of_day,
            threat_count=len(shaped.threats),
            visibility=shaped.visibility,
            sensor_quality=shaped.sensor_quality,
            duration_seconds=shaped.duration_seconds,
            threats=shaped.threats,
        ) == 10


def test_single_contact_requests_never_form_a_swarm() -> None:
    scenario = generate_scenario(
        _swarm_request(difficulty=6, environment="rural", time_of_day="day", threat_count=1),
        11,
    )
    assert all(t.swarm_id is None for t in scenario.threats)


def test_swarm_identity_keeps_response_mapping_valid() -> None:
    scenario = generate_scenario(
        _swarm_request(difficulty=10, environment="rural", time_of_day="day", threat_count=5),
        42,
    )
    for threat in scenario.threats:
        assert threat.expected_response == LABEL_TO_RESPONSE[threat.classification_label]
