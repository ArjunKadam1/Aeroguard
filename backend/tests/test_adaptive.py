from __future__ import annotations

from app.services.adaptive import (
    RecommendInput,
    SessionSummary,
    aggregate_performance,
    build_recommendation,
    clamp_level,
    decide_difficulty_delta,
    resolve_current_level,
)


def _summary(final=80.0, detection=24.0, classification=24.0, response=20.0,
              time_of_day="day", visibility="clear", threat_count=1, reaction=2000.0,
              environment="urban", sensor_quality=0.8, difficulty=1) -> SessionSummary:
    return SessionSummary(
        final_score=final, detection_score=detection, classification_score=classification,
        response_score=response, environment=environment, time_of_day=time_of_day,
        visibility=visibility, threat_count=threat_count, average_reaction_ms=reaction,
        sensor_quality=sensor_quality, difficulty=difficulty,
    )


def test_resolve_current_level_seeds_from_last_played_difficulty() -> None:
    sessions = [_summary(difficulty=2), _summary(difficulty=6)]
    # No stored level yet: seed from the most recent scenario actually played.
    assert resolve_current_level(None, sessions) == 6
    assert resolve_current_level(None, []) == 1


def test_resolve_current_level_prefers_stored_level() -> None:
    sessions = [_summary(difficulty=6)]
    assert resolve_current_level(3, sessions) == 3
    assert resolve_current_level(99, sessions) == 10
    assert resolve_current_level(0, sessions) == 1


def test_decide_difficulty_delta_rules() -> None:
    assert decide_difficulty_delta([94, 92, 93]) == 1
    assert decide_difficulty_delta([55, 58]) == -1
    assert decide_difficulty_delta([70, 80, 75]) == 0
    assert decide_difficulty_delta([95, 96]) == 0  # not enough history for +1


def test_clamp_level() -> None:
    assert clamp_level(0) == 1
    assert clamp_level(11) == 10
    assert clamp_level(5) == 5


def test_aggregate_performance() -> None:
    sessions = [
        _summary(final=100.0, detection=30.0, classification=30.0, response=25.0, time_of_day="day"),
        _summary(final=60.0, detection=30.0, classification=0.0, response=0.0,
                 time_of_day="night", visibility="reduced", threat_count=3, reaction=4000.0,
                 environment="rural", sensor_quality=0.5),
    ]
    profile = aggregate_performance("TRAIN-001", sessions, current_level=4)
    assert profile.session_count == 2
    assert profile.detection_accuracy == 100.0
    assert profile.classification_accuracy == 50.0
    assert profile.response_accuracy == 50.0
    assert profile.day_score == 100.0
    assert profile.night_score == 60.0
    assert profile.multi_threat_score == 60.0
    assert profile.low_visibility_score == 60.0
    assert profile.average_reaction_time_ms == 3000.0
    assert profile.current_level == 4
    # Phase 5: condition-specific metrics
    assert profile.urban_score == 100.0
    assert profile.rural_score == 60.0
    assert profile.clear_visibility_score == 100.0
    assert profile.reduced_visibility_score == 60.0
    assert profile.poor_visibility_score is None  # no poor-visibility sessions
    assert profile.high_sensor_score == 100.0
    assert profile.medium_sensor_score == 60.0
    assert profile.low_sensor_score is None  # no low-sensor sessions


def test_aggregate_performance_sensor_bins() -> None:
    sessions = [
        _summary(final=90.0, sensor_quality=0.9),
        _summary(final=70.0, sensor_quality=0.5),
        _summary(final=50.0, sensor_quality=0.2),
    ]
    profile = aggregate_performance("TRAIN-BINS", sessions)
    assert profile.high_sensor_score == 90.0
    assert profile.medium_sensor_score == 70.0
    assert profile.low_sensor_score == 50.0


def test_aggregate_performance_empty() -> None:
    profile = aggregate_performance("TRAIN-X", [], current_level=2)
    assert profile.session_count == 0
    assert profile.detection_accuracy == 0.0
    assert profile.night_score is None


def _input(**overrides) -> RecommendInput:
    base = dict(
        recent_final_scores=[80.0, 80.0, 80.0], overall_score=80.0, night_score=None,
        multi_threat_score=None, last_environment="urban", last_time_of_day="day",
        last_threat_count=2, current_level=3,
    )
    base.update(overrides)
    return RecommendInput(**base)


def test_recommend_increases_after_three_strong_sessions() -> None:
    result = build_recommendation(_input(recent_final_scores=[94, 92, 93], overall_score=93.0))
    assert result.recommended_difficulty == 4
    assert "increasing" in result.reason.lower()
    assert result.time_of_day.value == "day"


def test_recommend_decreases_after_two_weak_sessions() -> None:
    result = build_recommendation(_input(recent_final_scores=[55, 58], overall_score=56.5))
    assert result.recommended_difficulty == 2
    assert "decreasing" in result.reason.lower()


def test_recommend_targets_night_without_raising_difficulty() -> None:
    result = build_recommendation(_input(night_score=60.0, overall_score=85.0, current_level=5))
    assert result.time_of_day.value == "night"
    assert result.recommended_difficulty == 5  # no over-adaptation
    assert "night" in result.reason.lower()


def test_recommend_targets_multi_threat() -> None:
    result = build_recommendation(
        _input(multi_threat_score=60.0, overall_score=85.0, last_threat_count=1, current_level=5)
    )
    assert result.threat_count == 3
    assert result.recommended_difficulty == 5


def test_recommend_empty_history_defaults() -> None:
    result = build_recommendation(
        _input(recent_final_scores=[], overall_score=None, current_level=1)
    )
    assert result.recommended_difficulty == 1
    assert "no completed sessions" in result.reason.lower()


def test_recommend_targets_weak_environment_without_raising_difficulty() -> None:
    result = build_recommendation(
        _input(urban_score=60.0, rural_score=85.0, overall_score=85.0, current_level=5)
    )
    assert result.environment.value == "urban"
    assert result.recommended_difficulty == 5  # one dimension changes at a time
    assert "urban" in result.reason.lower()
    assert "60.0" in result.reason and "85.0" in result.reason


def test_recommend_environment_picks_the_weaker_side() -> None:
    result = build_recommendation(
        _input(urban_score=84.0, rural_score=55.0, overall_score=84.0, current_level=4)
    )
    assert result.environment.value == "rural"
    assert "rural" in result.reason.lower()


def test_night_weakness_takes_priority_over_environment() -> None:
    result = build_recommendation(
        _input(night_score=55.0, urban_score=55.0, rural_score=55.0,
               overall_score=85.0, current_level=3)
    )
    assert result.time_of_day.value == "night"
    assert result.environment.value == "urban"  # last environment unchanged
    assert "night" in result.reason.lower()


def test_recommend_reason_cites_visibility_and_sensor_weaknesses() -> None:
    result = build_recommendation(
        _input(poor_visibility_score=58.0, low_sensor_score=62.0, overall_score=85.0)
    )
    reason = result.reason.lower()
    assert "poor-visibility score 58.0" in reason
    assert "low-sensor score 62.0" in reason
    assert "weakened conditions" in reason


def test_recommend_reason_omits_evidence_when_conditions_are_strong() -> None:
    result = build_recommendation(
        _input(reduced_visibility_score=82.0, poor_visibility_score=84.0,
               low_sensor_score=80.0, overall_score=85.0)
    )
    assert "weakened conditions" not in result.reason.lower()


def test_recommend_reason_cites_acquisition_lag() -> None:
    result = build_recommendation(_input(mean_acquisition_ms=12400.0))
    reason = result.reason.lower()
    assert "acquisition lag" in reason
    assert "12.4s" in reason
    # Evidence only: the difficulty decision is unchanged.
    assert result.recommended_difficulty == 3


def test_recommend_reason_cites_radar_reliance() -> None:
    result = build_recommendation(_input(radar_detection_share=0.75))
    reason = result.reason.lower()
    assert "radar reliance" in reason
    assert "75%" in reason
    assert result.recommended_difficulty == 3


def test_recommend_reason_omits_observation_evidence_when_sharp() -> None:
    result = build_recommendation(
        _input(mean_acquisition_ms=2000.0, radar_detection_share=0.0)
    )
    assert "observation loop" not in result.reason.lower()
