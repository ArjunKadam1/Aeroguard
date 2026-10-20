"""Redacted scenario view: cues for the trainee, answers stay server-side."""

from app.schemas.scenario import ClassificationLabel, Visibility
from app.services.observation_cues import (
    BEHAVIOR_BY_LABEL,
    INDETERMINATE,
    OBSERVATION_VERSION,
    build_public_scenario,
    cue_clarity,
    cue_for_threat,
)

VALID_BEHAVIORS = set(BEHAVIOR_BY_LABEL.values()) | {INDETERMINATE}


def _generate(client, seed: int, threat_count: int = 2, swarms: bool = False) -> dict:
    response = client.post(
        "/api/v1/scenarios/generate",
        json={
            "difficulty": 6,
            "environment": "urban",
            "time_of_day": "day",
            "threat_count": threat_count,
            "seed": seed,
            "swarms": swarms,
        },
    )
    assert response.status_code == 200
    return response.json()


def test_view_never_contains_answers(client) -> None:
    scenario = _generate(client, seed=4242)
    view = client.get(f"/api/v1/scenarios/{scenario['scenario_id']}/view").json()
    # The legend is shared doctrine ("often friendly"), not per-contact truth:
    # what must be absent is any field that carries this scenario's answers.
    assert "classification_label" not in str(view)
    assert "expected_response" not in str(view)
    for threat in view["threats"]:
        assert set(threat.keys()) == {
            "id", "spawn_time", "speed_class", "visibility_class",
            "flight_pattern", "behavior", "cue_clear", "swarm_id", "swarm_index",
        }
    assert set(view.keys()) == {
        "scenario_id", "seed", "observation_version", "difficulty",
        "environment", "time_of_day", "visibility", "sensor_quality",
        "duration_seconds", "threats", "cue_legend",
    }


def test_view_is_deterministic_for_same_scenario(client) -> None:
    scenario = _generate(client, seed=4242)
    first = client.get(f"/api/v1/scenarios/{scenario['scenario_id']}/view").json()
    second = client.get(f"/api/v1/scenarios/{scenario['scenario_id']}/view").json()
    assert first == second


def test_view_unknown_scenario_is_404(client) -> None:
    response = client.get("/api/v1/scenarios/SCN-000000/view")
    assert response.status_code == 404


def test_view_defaults_swarm_membership_to_null(client) -> None:
    scenario = _generate(client, seed=4242)
    view = client.get(f"/api/v1/scenarios/{scenario['scenario_id']}/view").json()
    assert all(
        threat["swarm_id"] is None and threat["swarm_index"] is None
        for threat in view["threats"]
    )


def test_view_carries_swarm_membership_without_answers(client) -> None:
    scenario = _generate(client, seed=4242, threat_count=3, swarms=True)
    view = client.get(f"/api/v1/scenarios/{scenario['scenario_id']}/view").json()
    assert "classification_label" not in str(view)
    assert "expected_response" not in str(view)
    members = [threat for threat in view["threats"] if threat["swarm_id"]]
    assert members, "swarms=True must yield a group for a three-contact scenario"
    assert sorted(threat["swarm_index"] for threat in members) == list(
        range(len(members))
    )
    assert len({threat["spawn_time"] for threat in members}) == 1
    assert len({threat["flight_pattern"] for threat in members}) == 1


def test_perfect_conditions_read_every_signature() -> None:
    # sensor 1.0 + clear visibility => clarity 1.0 => every roll succeeds, so
    # each contact shows its true signature.
    from app.schemas.scenario import Scenario, ThreatProfile

    labels = list(ClassificationLabel)
    scenario = Scenario(
        scenario_id="SCN-000001", seed=11, generator_version="1.0", difficulty=4,
        environment="urban", time_of_day="day", visibility="clear",
        sensor_quality=1.0, duration_seconds=120,
        threats=[
            ThreatProfile(
                id=f"T{i + 1:02d}", classification_label=label,
                expected_response="hold", spawn_time=float(i),
            )
            for i, label in enumerate(labels)
        ],
    )
    view = build_public_scenario(scenario)
    assert len(view.threats) == len(labels)
    for threat, label in zip(view.threats, labels):
        assert (threat.behavior, threat.cue_clear) == (BEHAVIOR_BY_LABEL[label], True)


def test_cue_clarity_bounds() -> None:
    assert cue_clarity(1.0, Visibility.clear) == 1.0
    assert cue_clarity(0.0, Visibility.clear) == 0.0
    assert cue_clarity(1.0, Visibility.poor) == 0.5
    assert 0.0 <= cue_clarity(0.2, Visibility.reduced) <= 1.0


def test_cue_matches_label_under_perfect_conditions() -> None:
    from app.schemas.scenario import ThreatProfile

    threat = ThreatProfile(
        id="T01",
        classification_label=ClassificationLabel.hostile,
        expected_response="hold",
        spawn_time=1.0,
    )
    behavior, clear = cue_for_threat(threat, seed=7, sensor_quality=1.0, visibility=Visibility.clear)
    assert (behavior, clear) == ("direct-approach", True)


def test_cue_degrades_to_indeterminate_not_wrong_answers() -> None:
    from app.schemas.scenario import ThreatProfile

    # Zero sensor quality => clarity 0 => every cue is indeterminate, never a
    # misleading wrong signature.
    for label in ClassificationLabel:
        threat = ThreatProfile(
            id="T01", classification_label=label, expected_response="hold", spawn_time=1.0
        )
        behavior, clear = cue_for_threat(
            threat, seed=99, sensor_quality=0.0, visibility=Visibility.poor
        )
        assert (behavior, clear) == (INDETERMINATE, False)


def test_build_public_scenario_version_and_legend() -> None:
    from app.schemas.scenario import Scenario

    scenario = Scenario(
        scenario_id="SCN-000001", seed=5, generator_version="1.0", difficulty=4,
        environment="urban", time_of_day="day", visibility="clear",
        sensor_quality=1.0, duration_seconds=120, threats=[],
    )
    view = build_public_scenario(scenario)
    assert view.observation_version == OBSERVATION_VERSION
    assert view.cue_legend[INDETERMINATE].startswith("signature unreadable")
