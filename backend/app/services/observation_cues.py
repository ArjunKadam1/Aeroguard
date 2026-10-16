"""Observable behavior cues derived from scenario ground truth.

Classification must be fair: hiding the label without giving the trainee any
evidence to infer it would reduce classification to guessing. Each ground-truth
label therefore produces an observable behavior signature, and simulated
conditions (sensor quality, visibility) decide whether the signature reads
cleanly or degrades to "indeterminate".

Deterministic: same (seed, threat id) always yields the same cue, so sessions
are reproducible and testable. The stored Scenario is never modified; cues are
computed on the way out for the redacted public view only.

Source of truth for behavior doctrine: this module (CUE_LEGEND). The client
renders the legend verbatim rather than inventing its own mapping.
"""

from __future__ import annotations

import random

from app.schemas.observation import PublicScenario, PublicThreat
from app.schemas.scenario import (
    ClassificationLabel,
    Scenario,
    ThreatProfile,
    Visibility,
)

OBSERVATION_VERSION = "1.0"

# Ground truth -> observable signature. Deliberately coarse: several labels can
# share a signature family, and degradation can erase it entirely, so reading
# cues is a skill rather than a lookup.
BEHAVIOR_BY_LABEL: dict[ClassificationLabel, str] = {
    ClassificationLabel.friendly: "steady-transit",
    ClassificationLabel.civilian: "slow-drift",
    ClassificationLabel.unknown: "erratic",
    ClassificationLabel.suspicious: "orbiting",
    ClassificationLabel.hostile: "direct-approach",
}

INDETERMINATE = "indeterminate"

CUE_LEGEND: dict[str, str] = {
    "steady-transit": "steady, level flight — often friendly",
    "slow-drift": "slow, wandering path — often civilian",
    "erratic": "unpredictable maneuvers — identity unclear",
    "orbiting": "circling a point of interest — often suspicious",
    "direct-approach": "fast, direct inbound track — often hostile",
    INDETERMINATE: "signature unreadable under current conditions",
}

_VISIBILITY_FACTOR: dict[Visibility, float] = {
    Visibility.clear: 1.0,
    Visibility.reduced: 0.75,
    Visibility.poor: 0.5,
}


def cue_clarity(sensor_quality: float, visibility: Visibility) -> float:
    """Probability that a contact's signature reads cleanly (0..1)."""
    clarity = sensor_quality * _VISIBILITY_FACTOR[visibility]
    return max(0.0, min(1.0, clarity))


def _roll(seed: int, threat_id: str) -> float:
    # String-seeded so the roll is stable across processes and platforms for
    # the same scenario; random.Random(str) is deterministic per Python build.
    return random.Random(f"{seed}:{threat_id}:{OBSERVATION_VERSION}").random()


def cue_for_threat(
    threat: ThreatProfile, seed: int, sensor_quality: float, visibility: Visibility
) -> tuple[str, bool]:
    """(behavior, cue_clear) for one threat. Pure and deterministic."""
    if _roll(seed, threat.id) < cue_clarity(sensor_quality, visibility):
        return BEHAVIOR_BY_LABEL[threat.classification_label], True
    return INDETERMINATE, False


def build_public_scenario(scenario: Scenario) -> PublicScenario:
    """Redacted trainee view: kinematics and cues, never answers."""
    threats: list[PublicThreat] = []
    for threat in scenario.threats:
        behavior, clear = cue_for_threat(
            threat, scenario.seed, scenario.sensor_quality, scenario.visibility
        )
        threats.append(
            PublicThreat(
                id=threat.id,
                spawn_time=threat.spawn_time,
                speed_class=threat.speed_class,
                visibility_class=threat.visibility_class,
                flight_pattern=threat.flight_pattern,
                behavior=behavior,
                cue_clear=clear,
            )
        )
    return PublicScenario(
        scenario_id=scenario.scenario_id,
        seed=scenario.seed,
        observation_version=OBSERVATION_VERSION,
        difficulty=scenario.difficulty,
        environment=scenario.environment,
        time_of_day=scenario.time_of_day,
        visibility=scenario.visibility,
        sensor_quality=scenario.sensor_quality,
        duration_seconds=scenario.duration_seconds,
        threats=threats,
        cue_legend=dict(CUE_LEGEND),
    )
