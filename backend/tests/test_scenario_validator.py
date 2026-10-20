import pytest

from app.schemas.scenario import (
    ClassificationLabel,
    ExpectedResponse,
    FlightPattern,
    ScenarioGenerateRequest,
)
from app.services.scenario_generator import LABEL_TO_RESPONSE, generate_scenario
from app.services.scenario_validator import ScenarioValidationError, validate_scenario


def _valid_scenario():
    request = ScenarioGenerateRequest(
        difficulty=6, environment="urban", time_of_day="night", threat_count=2
    )
    return generate_scenario(request, 12345)


def test_valid_generated_scenario_passes() -> None:
    validate_scenario(_valid_scenario())


def test_duplicate_threat_ids_rejected() -> None:
    scenario = _valid_scenario()
    scenario.threats[1].id = scenario.threats[0].id
    with pytest.raises(ScenarioValidationError):
        validate_scenario(scenario)


def test_empty_threats_rejected() -> None:
    scenario = _valid_scenario()
    scenario.threats = []
    with pytest.raises(ScenarioValidationError):
        validate_scenario(scenario)


def test_spawn_time_outside_duration_rejected() -> None:
    scenario = _valid_scenario()
    scenario.threats[0].spawn_time = scenario.duration_seconds + 1
    with pytest.raises(ScenarioValidationError):
        validate_scenario(scenario)


def test_response_mismatch_rejected() -> None:
    scenario = _valid_scenario()
    current = scenario.threats[0].expected_response
    scenario.threats[0].expected_response = next(
        response for response in ExpectedResponse if response != current
    )
    with pytest.raises(ScenarioValidationError):
        validate_scenario(scenario)


def test_declared_difficulty_mismatch_rejected() -> None:
    scenario = _valid_scenario()
    scenario.difficulty = scenario.difficulty + 1
    with pytest.raises(ScenarioValidationError):
        validate_scenario(scenario)


def test_sensor_quality_out_of_range_rejected() -> None:
    scenario = _valid_scenario()
    scenario.sensor_quality = 1.5
    with pytest.raises(ScenarioValidationError):
        validate_scenario(scenario)


def test_difficulty_out_of_range_rejected() -> None:
    scenario = _valid_scenario()
    scenario.difficulty = 0
    with pytest.raises(ScenarioValidationError):
        validate_scenario(scenario)


def test_non_positive_duration_rejected() -> None:
    scenario = _valid_scenario()
    scenario.duration_seconds = 0
    with pytest.raises(ScenarioValidationError):
        validate_scenario(scenario)


# --- Swarm membership -------------------------------------------------------


def _swarm_scenario():
    request = ScenarioGenerateRequest(
        difficulty=10,
        environment="rural",
        time_of_day="day",
        threat_count=5,
        swarms=True,
    )
    return generate_scenario(request, 4242)


def _swarm_members(scenario):
    groups: dict[str, list] = {}
    for threat in scenario.threats:
        if threat.swarm_id is not None:
            groups.setdefault(threat.swarm_id, []).append(threat)
    return groups


def test_valid_generated_swarm_scenario_passes() -> None:
    validate_scenario(_swarm_scenario())


def test_swarm_index_without_id_rejected() -> None:
    scenario = _swarm_scenario()
    member = next(t for t in scenario.threats if t.swarm_id is not None)
    member.swarm_id = None
    with pytest.raises(ScenarioValidationError):
        validate_scenario(scenario)


def test_singleton_swarm_rejected() -> None:
    scenario = _swarm_scenario()
    _, members = next(iter(_swarm_members(scenario).items()))
    for threat in members[1:]:
        threat.swarm_id = None
        threat.swarm_index = None
    with pytest.raises(ScenarioValidationError):
        validate_scenario(scenario)


def test_non_contiguous_swarm_indices_rejected() -> None:
    scenario = _swarm_scenario()
    member = next(t for t in scenario.threats if t.swarm_id is not None)
    member.swarm_index = 9
    with pytest.raises(ScenarioValidationError):
        validate_scenario(scenario)


def test_swarm_pattern_mismatch_rejected() -> None:
    scenario = _swarm_scenario()
    _, members = next(iter(_swarm_members(scenario).items()))
    current = members[0].flight_pattern
    members[0].flight_pattern = next(
        pattern for pattern in FlightPattern if pattern != current
    )
    with pytest.raises(ScenarioValidationError):
        validate_scenario(scenario)


def test_swarm_spawn_mismatch_rejected() -> None:
    scenario = _swarm_scenario()
    _, members = next(iter(_swarm_members(scenario).items()))
    members[0].spawn_time = members[0].spawn_time + 1.0
    with pytest.raises(ScenarioValidationError):
        validate_scenario(scenario)


def test_swarm_identity_mismatch_rejected() -> None:
    scenario = _swarm_scenario()
    _, members = next(iter(_swarm_members(scenario).items()))
    other = next(
        label for label in ClassificationLabel
        if label != members[0].classification_label
    )
    members[0].classification_label = other
    members[0].expected_response = LABEL_TO_RESPONSE[other]
    with pytest.raises(ScenarioValidationError):
        validate_scenario(scenario)
