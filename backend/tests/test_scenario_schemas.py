import pytest
from pydantic import ValidationError

from app.schemas.scenario import (
    Scenario,
    ScenarioGenerateRequest,
    ThreatProfile,
)


def test_request_accepts_valid_configuration() -> None:
    req = ScenarioGenerateRequest(
        difficulty=5, environment="urban", time_of_day="night", threat_count=2
    )
    assert req.threat_count == 2
    assert req.seed is None
    assert req.swarms is False


def test_request_accepts_opt_in_swarms() -> None:
    req = ScenarioGenerateRequest(
        difficulty=5, environment="urban", time_of_day="night", threat_count=2,
        swarms=True,
    )
    assert req.swarms is True


def test_threat_swarm_fields_default_to_none() -> None:
    threat = ThreatProfile(
        id="T01",
        classification_label="hostile",
        expected_response="hold",
        spawn_time=12.5,
    )
    assert threat.swarm_id is None
    assert threat.swarm_index is None


def test_request_rejects_difficulty_out_of_range() -> None:
    with pytest.raises(ValidationError):
        ScenarioGenerateRequest(
            difficulty=11, environment="urban", time_of_day="day", threat_count=1
        )


def test_request_rejects_unknown_threat_count() -> None:
    with pytest.raises(ValidationError):
        ScenarioGenerateRequest(
            difficulty=5, environment="urban", time_of_day="day", threat_count=4
        )


def test_request_rejects_unknown_environment() -> None:
    with pytest.raises(ValidationError):
        ScenarioGenerateRequest(
            difficulty=5, environment="space", time_of_day="day", threat_count=1
        )


def test_scenario_round_trips_through_model_dump() -> None:
    threat = ThreatProfile(
        id="T01",
        classification_label="hostile",
        expected_response="hold",
        spawn_time=12.5,
    )
    scenario = Scenario(
        scenario_id="SCN-000123",
        seed=123,
        generator_version="1.0",
        difficulty=6,
        environment="urban",
        time_of_day="night",
        visibility="reduced",
        sensor_quality=0.65,
        duration_seconds=120,
        threats=[threat],
    )
    assert Scenario(**scenario.model_dump()) == scenario


def test_scenario_rejects_sensor_quality_above_one() -> None:
    with pytest.raises(ValidationError):
        Scenario(
            scenario_id="SCN-000123",
            seed=123,
            generator_version="1.0",
            difficulty=6,
            environment="urban",
            time_of_day="night",
            visibility="reduced",
            sensor_quality=1.5,
            duration_seconds=120,
            threats=[],
        )


def test_scenario_requires_positive_duration() -> None:
    with pytest.raises(ValidationError):
        Scenario(
            scenario_id="SCN-000123",
            seed=123,
            generator_version="1.0",
            difficulty=6,
            environment="urban",
            time_of_day="night",
            visibility="reduced",
            sensor_quality=0.5,
            duration_seconds=0,
            threats=[],
        )
