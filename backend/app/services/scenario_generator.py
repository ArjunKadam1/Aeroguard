"""Deterministic scenario generator.

Same (request, seed) always produces an identical Scenario (NFR-01).
Difficulty is an exact target: the generator solves for visibility,
sensor quality and duration such that the additive difficulty model
equals the requested value, and rejects unreachable combinations.

Source of truth: docs/modules/scenario_engine.md and docs/api/openapi.yaml.
"""

from __future__ import annotations

import random
from collections.abc import Iterable

from app.schemas.scenario import (
    ClassificationLabel,
    Environment,
    ExpectedResponse,
    FlightPattern,
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
_FLIGHT_PATTERNS: tuple[FlightPattern, ...] = tuple(FlightPattern)

# Motion load per pattern, mirroring the client acquisition table
# (sim/observation.ts PATTERN_ACQUIRE): patterns at or below 0.8 acquisition
# price into difficulty, milder ones stay within noise. A session is as hard
# as its hardest contact, capped at 2 so the residual solver keeps room for
# visibility, sensor, and timing conditions.
PATTERN_MOTION: dict[FlightPattern, int] = {
    FlightPattern.straight_transit: 0,
    FlightPattern.direct_approach: 0,
    FlightPattern.orbit_hold: 0,
    FlightPattern.altitude_step: 0,
    FlightPattern.perimeter_sweep: 0,
    FlightPattern.wide_weave: 1,
    FlightPattern.erratic_jink: 2,
}
MAX_MOTION = 2


def pattern_motion(patterns: Iterable[FlightPattern | None]) -> int:
    """Difficulty cost of a motion mix. Missing patterns cost nothing, so old
    fixtures and pattern-less threats validate exactly as before."""
    return min(MAX_MOTION, max([PATTERN_MOTION.get(p, 0) if p is not None else 0 for p in patterns] or [0]))


def motion_factor(threats: list[ThreatProfile]) -> int:
    return pattern_motion([t.flight_pattern for t in threats])


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
    threats: list[ThreatProfile] | None = None,
) -> int:
    return (
        BASE_DIFFICULTY
        + THREAT_COUNT_FACTOR[threat_count]
        + ENVIRONMENT_FACTOR[environment]
        + TIME_FACTOR[time_of_day]
        + VISIBILITY_TIERS.index(visibility)
        + sensor_factor(sensor_quality)
        + timing_factor(duration_seconds)
        + motion_factor(threats or [])
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


def _draw_patterns(seed: int, count: int, max_motion: int) -> list[FlightPattern]:
    # Own stream, drawn in index order. Only patterns affordable by the
    # difficulty budget are eligible, so feasibility never depends on the
    # draw: the same request is feasible for every seed. Calm patterns are
    # always eligible, so low difficulties fly steady contacts only.
    pattern_rng = random.Random(f"flight-pattern:{seed}")
    eligible = [p for p in _FLIGHT_PATTERNS if PATTERN_MOTION[p] <= max_motion]
    return [pattern_rng.choice(eligible) for _ in range(count)]


def _build_threats(
    rng: random.Random,
    count: int,
    duration_seconds: float,
    visibility: Visibility,
    patterns: list[FlightPattern],
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
                flight_pattern=patterns[index],
            )
        )
    return threats


# --- Swarm grouping ---------------------------------------------------------
# Grouping is opt-in and never changes the contact count: swarms are a
# partition of the threats the request already asks for. A group shares one
# identity (label, expected response, pattern, spawn, speed) so every member
# is still a separately scored contact with a coherent observable signature.
# The member pattern is the most demanding pattern drawn inside the group, so
# the motion cost -- and therefore the conditions and declared difficulty --
# is exactly the same as the ungrouped run for the same seed.


def _swarm_partition(seed: int, count: int) -> list[int]:
    """Deterministic group sizes from a dedicated RNG stream.

    A separate stream means enabling swarms can never disturb the draws that
    visibility, sensor quality, duration, labels and spawn times come from.
    """
    if count < 2:
        return [count] if count else []
    rng = random.Random(f"swarm:{seed}")
    if count == 2:
        return [2]
    if count == 3:
        return rng.choice(([3], [2, 1]))
    if count == 5:
        return rng.choice(([5], [3, 2]))
    return [count]


def _swarm_groups(seed: int, count: int, enabled: bool) -> list[tuple[int, ...]]:
    """Index groups of two or more; singleton partitions stay independent."""
    if not enabled:
        return []
    groups: list[tuple[int, ...]] = []
    start = 0
    for size in _swarm_partition(seed, count):
        if size >= 2:
            groups.append(tuple(range(start, start + size)))
        start += size
    return groups


def _share_group_patterns(
    patterns: list[FlightPattern], groups: list[tuple[int, ...]]
) -> None:
    """Give every member the group's most demanding pattern, in place.

    Taking the max preserves `pattern_motion`, so the residual split and the
    allocated conditions match an ungrouped run of the same seed exactly.
    Ties keep the earliest member's pattern, so the result is deterministic.
    """
    for group in groups:
        best = patterns[group[0]]
        for index in group[1:]:
            if PATTERN_MOTION[patterns[index]] > PATTERN_MOTION[best]:
                best = patterns[index]
        for index in group:
            patterns[index] = best


def _apply_swarms(
    threats: list[ThreatProfile], groups: list[tuple[int, ...]]
) -> list[ThreatProfile]:
    """Stamp membership and share the lead's identity inside each group."""
    for number, group in enumerate(groups):
        leader = threats[group[0]]
        swarm_id = f"S{number + 1:02d}"
        for position, index in enumerate(group):
            threats[index] = threats[index].model_copy(
                update={
                    "swarm_id": swarm_id,
                    "swarm_index": position,
                    "classification_label": leader.classification_label,
                    "expected_response": leader.expected_response,
                    "flight_pattern": leader.flight_pattern,
                    "spawn_time": leader.spawn_time,
                    "speed_class": leader.speed_class,
                }
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
    # Motion prices into difficulty without touching feasibility: patterns are
    # drawn within the residual budget, then the ACTUAL motion cost is
    # subtracted before conditions are allocated. Calm seeds keep byte-exact
    # conditions; demanding seeds trade conditions for motion one-for-one, and
    # the declared difficulty always equals fixed + conditions + motion.
    residual = request.difficulty - fixed
    if residual < 0 or residual > 6:
        raise InfeasibleScenarioError(
            f"difficulty {request.difficulty} is unreachable for "
            f"environment={request.environment.value}, "
            f"time_of_day={request.time_of_day.value}, "
            f"threat_count={request.threat_count}"
        )
    patterns = _draw_patterns(seed, request.threat_count, residual)
    groups = _swarm_groups(seed, request.threat_count, request.swarms)
    _share_group_patterns(patterns, groups)
    motion = pattern_motion(patterns)
    vis_factor, sensor_index, timing_index = _allocate_residual(rng, residual - motion)
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
        threats=_apply_swarms(
            _build_threats(
                rng, request.threat_count, duration_seconds, visibility, patterns
            ),
            groups,
        ),
    )
