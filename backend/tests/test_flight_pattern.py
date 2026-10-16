"""Flight-pattern assignment: independent trajectory vocabulary (T0).

Patterns are observable motion assigned on their own deterministic stream,
independent of classification labels. T0 wires the contract only; every
pattern still executes corridor motion until T1.
"""

from app.schemas.scenario import FlightPattern, ScenarioGenerateRequest, ThreatProfile
from app.services.observation_cues import build_public_scenario
from app.services.scenario_generator import generate_scenario
from app.services.scenario_validator import validate_scenario


def _request(**overrides) -> ScenarioGenerateRequest:
    base = dict(difficulty=6, environment="urban", time_of_day="night", threat_count=3)
    base.update(overrides)
    return ScenarioGenerateRequest(**base)


def test_generator_assigns_a_valid_pattern_to_every_threat() -> None:
    for seed in range(30):
        scenario = generate_scenario(_request(), seed)
        assert len(scenario.threats) == 3
        for threat in scenario.threats:
            assert isinstance(threat.flight_pattern, FlightPattern)


def test_patterns_are_deterministic_per_seed() -> None:
    first = generate_scenario(_request(), 999)
    second = generate_scenario(_request(), 999)
    assert [t.flight_pattern for t in first.threats] == [t.flight_pattern for t in second.threats]


def test_pattern_stream_never_perturbs_labels_spawns_or_speeds() -> None:
    # Separate RNG stream for patterns: the pre-existing draws keep their
    # exact values, locked here so any future stream sharing is caught.
    scenario = generate_scenario(_request(), 999)
    assert [(t.id, t.classification_label.value, t.spawn_time) for t in scenario.threats] == [
        ("T01", "suspicious", 1.6),
        ("T02", "unknown", 37.7),
        ("T03", "friendly", 67.7),
    ]


def test_pattern_vocabulary_is_covered_across_seeds() -> None:
    seen = set()
    for seed in range(300):
        for threat in generate_scenario(_request(), seed).threats:
            assert threat.flight_pattern is not None
            seen.add(threat.flight_pattern)
    assert seen == set(FlightPattern)


def test_patterns_are_independent_of_labels() -> None:
    # No label may map to a single pattern: motion must never identify truth.
    by_label: dict[str, set] = {}
    for seed in range(300):
        for threat in generate_scenario(_request(), seed).threats:
            assert threat.flight_pattern is not None
            by_label.setdefault(threat.classification_label.value, set()).add(threat.flight_pattern)
    assert by_label
    for label, patterns in by_label.items():
        assert len(patterns) > 1, f"label {label} maps to a single pattern"


def test_view_passes_the_pattern_through_redacted() -> None:
    scenario = generate_scenario(_request(), 999)
    view = build_public_scenario(scenario)
    for profile, public in zip(scenario.threats, view.threats):
        assert public.flight_pattern == profile.flight_pattern
    assert "classification_label" not in str(view)


def test_missing_pattern_still_validates_for_old_fixtures() -> None:
    profile = ThreatProfile(
        id="T01", classification_label="hostile", expected_response="hold", spawn_time=1.0,
    )
    assert profile.flight_pattern is None
    scenario = generate_scenario(_request(threat_count=1), 7)
    scenario.threats = [profile]
    validate_scenario(scenario)
    assert build_public_scenario(scenario).threats[0].flight_pattern is None
