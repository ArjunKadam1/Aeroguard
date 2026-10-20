"""Scenario validation rules (docs/modules/scenario_engine.md section 8).

The Scenario model already constrains field ranges (difficulty 1-10,
sensor_quality 0-1, duration > 0). This validator re-checks those ranges
so it stays a complete guard even for scenarios built without Pydantic
validation, and adds the relational rules the schema cannot express.
"""

from __future__ import annotations

from app.schemas.scenario import Scenario
from app.services.scenario_generator import LABEL_TO_RESPONSE, compute_difficulty


class ScenarioValidationError(ValueError):
    """Raised when a scenario violates a validation rule."""


def _validate_swarms(scenario: Scenario) -> None:
    """Relational rules for opt-in swarm membership.

    Grouping is observable behavior, not an answer: members must be a coherent
    group (shared identity, pattern, spawn and speed) so the trainee sees one
    formation and every member remains a separately scored contact.
    """
    groups: dict[str, list] = {}
    for threat in scenario.threats:
        if threat.swarm_id is None and threat.swarm_index is None:
            continue
        if threat.swarm_id is None or threat.swarm_index is None:
            raise ScenarioValidationError(
                f"threat {threat.id} must set both swarm_id and swarm_index"
            )
        if not threat.swarm_id:
            raise ScenarioValidationError(f"threat {threat.id} has an empty swarm_id")
        if threat.swarm_index < 0:
            raise ScenarioValidationError(
                f"threat {threat.id} has a negative swarm_index"
            )
        groups.setdefault(threat.swarm_id, []).append(threat)

    for swarm_id, members in groups.items():
        if len(members) < 2:
            raise ScenarioValidationError(
                f"swarm {swarm_id} needs at least two members"
            )
        indices = sorted(threat.swarm_index for threat in members)
        if indices != list(range(len(members))):
            raise ScenarioValidationError(
                f"swarm {swarm_id} indices must be contiguous from 0"
            )
        for field in (
            "classification_label",
            "expected_response",
            "flight_pattern",
            "spawn_time",
            "speed_class",
        ):
            if len({getattr(threat, field) for threat in members}) != 1:
                raise ScenarioValidationError(
                    f"swarm {swarm_id} members must share {field}"
                )


def validate_scenario(scenario: Scenario) -> None:
    if scenario.duration_seconds <= 0:
        raise ScenarioValidationError("duration_seconds must be > 0")

    if not 1 <= scenario.difficulty <= 10:
        raise ScenarioValidationError("difficulty must be inside 1-10")

    if not 0 <= scenario.sensor_quality <= 1:
        raise ScenarioValidationError("sensor_quality must be inside 0-1")

    if not scenario.threats:
        raise ScenarioValidationError("at least one threat is required")

    ids = [threat.id for threat in scenario.threats]
    if len(ids) != len(set(ids)):
        raise ScenarioValidationError("threat ids must be unique")

    for threat in scenario.threats:
        if not 0 <= threat.spawn_time < scenario.duration_seconds:
            raise ScenarioValidationError(
                f"spawn_time {threat.spawn_time} out of range for threat {threat.id}"
            )
        expected = LABEL_TO_RESPONSE[threat.classification_label]
        if threat.expected_response != expected:
            raise ScenarioValidationError(
                f"threat {threat.id} response {threat.expected_response.value} "
                f"does not match ground truth for "
                f"{threat.classification_label.value}"
            )

    _validate_swarms(scenario)

    computed = compute_difficulty(
        environment=scenario.environment,
        time_of_day=scenario.time_of_day,
        threat_count=len(scenario.threats),
        visibility=scenario.visibility,
        sensor_quality=scenario.sensor_quality,
        duration_seconds=scenario.duration_seconds,
        threats=scenario.threats,
    )
    if computed != scenario.difficulty:
        raise ScenarioValidationError(
            f"declared difficulty {scenario.difficulty} does not match computed {computed}"
        )
