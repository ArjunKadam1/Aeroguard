"""Deterministic scenario generator.

Same (request, seed) always produces an identical Scenario (NFR-01).
Difficulty is an exact target: the generator solves for visibility,
sensor quality and duration such that the additive difficulty model
equals the requested value, and rejects unreachable combinations.

Source of truth: docs/modules/scenario_engine.md and docs/api/openapi.yaml.
"""

from __future__ import annotations

import random

from app.schemas.scenario import (
    ClassificationLabel,
    Environment,
    ExpectedResponse,
    Scenario,
    ScenarioGenerateRequest,
    SpeedClass,
    ThreatProfile,
    TimeOfDay,
    Visibility,
)

GENERATOR_VERSION = "1.0"

# Threats appear within the first SPAWN_WINDOW_RATIO of the session, one slot
# per threat, so a scenario never opens with a long stretch of empty sky and no
# threat ever spawns too late to detect, classify and respond before auto-finish.
SPAWN_WINDOW_RATIO = 0.5
SPAWN_JITTER_RATIO = 0.4
# No threat may spawn in the last few seconds, since the trainee still needs to
# detect, classify and respond before the session auto-completes.
MIN_RESPONSE_SECONDS = 10.0

BASE_DIFFICULTY = 1
THREAT_COUNT_FACTOR: dict[int, int] = {1: 0, 2: 1, 3: 2, 5: 4}
ENVIRONMENT_FACTOR: dict[Environment, int] = {Environment.urban: 1, Environment.rural: 0}
TIME_FACTOR: dict[TimeOfDay, int] = {TimeOfDay.day: 0, TimeOfDay.night: 2}

VISIBILITY_TIERS: tuple[Visibility, ...] = (
    Visibility.clear,
    Visibility.reduced,
    Visibility.poor,
)

SENSOR_CHOICES: dict[int, tuple[float, ...]] = {
    0: (0.70, 0.75, 0.80, 0.85, 0.90, 0.95, 1.00),
    1: (0.40, 0.45, 0.50, 0.55, 0.60, 0.65),
    2: (0.10, 0.15, 0.20, 0.25, 0.30, 0.35),
}

DURATION_CHOICES: dict[int, tuple[float, ...]] = {
    0: (150.0, 160.0, 170.0, 180.0),
    1: (90.0, 105.0, 120.0, 135.0),
    2: (60.0, 70.0, 80.0),
}

LABEL_TO_RESPONSE: dict[ClassificationLabel, ExpectedResponse] = {
    ClassificationLabel.friendly: ExpectedResponse.monitor,
    ClassificationLabel.civilian: ExpectedResponse.monitor,
    ClassificationLabel.unknown: ExpectedResponse.track,
    ClassificationLabel.suspicious: ExpectedResponse.report,
    ClassificationLabel.hostile: ExpectedResponse.hold,
}

_THREAT_LABELS: tuple[ClassificationLabel, ...] = tuple(ClassificationLabel)
_SPEED_CLASSES: tuple[SpeedClass, ...] = tuple(SpeedClass)


class InfeasibleScenarioError(ValueError):
    """Raised when no configuration can reach the requested difficulty."""


def sensor_factor(sensor_quality: float) -> int:
    if sensor_quality >= 0.7:
        return 0
    if sensor_quality >= 0.4:
        return 1
    return 2


def timing_factor(duration_seconds: float) -> int:
    if duration_seconds >= 150:
        return 0
    if duration_seconds >= 90:
        return 1
    return 2


def compute_difficulty(
    *,
    environment: Environment,
    time_of_day: TimeOfDay,
    threat_count: int,
    visibility: Visibility,
    sensor_quality: float,
    duration_seconds: float,
) -> int:
    return (
        BASE_DIFFICULTY
        + THREAT_COUNT_FACTOR[threat_count]
        + ENVIRONMENT_FACTOR[environment]
        + TIME_FACTOR[time_of_day]
        + VISIBILITY_TIERS.index(visibility)
        + sensor_factor(sensor_quality)
        + timing_factor(duration_seconds)
    )


def _allocate_residual(rng: random.Random, residual: int) -> tuple[int, int, int]:
    combos = [
        (vis, sensor, timing)
        for vis in range(3)
        for sensor in range(3)
        for timing in range(3)
        if vis + sensor + timing == residual
    ]
    return rng.choice(combos)


def _build_threats(
    rng: random.Random,
    count: int,
    duration_seconds: float,
    visibility: Visibility,
) -> list[ThreatProfile]:
    threats: list[ThreatProfile] = []
    window = duration_seconds * SPAWN_WINDOW_RATIO
    slot = window / max(count, 1)
    for index in range(count):
        label = rng.choice(_THREAT_LABELS)
        # One slot per threat keeps multi-threat scenarios staggered, and the
        # jitter stays inside the slot so ordering is preserved.
        spawn_time = round(slot * index + rng.uniform(0.0, slot * SPAWN_JITTER_RATIO), 1)
        spawn_time = min(spawn_time, duration_seconds - MIN_RESPONSE_SECONDS)
        threats.append(
            ThreatProfile(
                id=f"T{index + 1:02d}",
                classification_label=label,
                expected_response=LABEL_TO_RESPONSE[label],
                spawn_time=spawn_time,
                speed_class=rng.choice(_SPEED_CLASSES),
                visibility_class=visibility,
            )
        )
    return threats


def generate_scenario(request: ScenarioGenerateRequest, seed: int) -> Scenario:
    rng = random.Random(seed)

    fixed = (
        BASE_DIFFICULTY
        + THREAT_COUNT_FACTOR[request.threat_count]
        + ENVIRONMENT_FACTOR[request.environment]
        + TIME_FACTOR[request.time_of_day]
    )
    residual = request.difficulty - fixed
    if residual < 0 or residual > 6:
        raise InfeasibleScenarioError(
            f"difficulty {request.difficulty} is unreachable for "
            f"environment={request.environment.value}, "
            f"time_of_day={request.time_of_day.value}, "
            f"threat_count={request.threat_count}"
        )

    vis_factor, sensor_index, timing_index = _allocate_residual(rng, residual)
    visibility = VISIBILITY_TIERS[vis_factor]
    sensor_quality = rng.choice(SENSOR_CHOICES[sensor_index])
    duration_seconds = rng.choice(DURATION_CHOICES[timing_index])

    return Scenario(
        scenario_id=f"SCN-{seed % 1_000_000:06d}",
        seed=seed,
        generator_version=GENERATOR_VERSION,
        difficulty=request.difficulty,
        environment=request.environment,
        time_of_day=request.time_of_day,
        visibility=visibility,
        sensor_quality=sensor_quality,
        duration_seconds=duration_seconds,
        threats=_build_threats(rng, request.threat_count, duration_seconds, visibility),
    )
