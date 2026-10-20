"""Pydantic models mirroring the frozen v1 scenario contract.

Source of truth: docs/api/openapi.yaml
(ScenarioGenerateRequest, ThreatProfile, Scenario).
"""

from __future__ import annotations

from enum import Enum
from typing import Literal

from pydantic import BaseModel, Field

ThreatCount = Literal[1, 2, 3, 5]


class Environment(str, Enum):
    urban = "urban"
    rural = "rural"


class TimeOfDay(str, Enum):
    day = "day"
    night = "night"


class Visibility(str, Enum):
    clear = "clear"
    reduced = "reduced"
    poor = "poor"


class ClassificationLabel(str, Enum):
    friendly = "friendly"
    civilian = "civilian"
    unknown = "unknown"
    suspicious = "suspicious"
    hostile = "hostile"


class ExpectedResponse(str, Enum):
    monitor = "monitor"
    track = "track"
    report = "report"
    hold = "hold"


class SpeedClass(str, Enum):
    slow = "slow"
    medium = "medium"
    fast = "fast"


class FlightPattern(str, Enum):
    """Independent trajectory vocabulary, assigned per threat.

    Deliberately independent of classification_label: motion is observable
    evidence and must never identify the hidden answer. The client executes
    these patterns from the redacted view; detection semantics are unchanged.
    """

    straight_transit = "straight-transit"
    wide_weave = "wide-weave"
    erratic_jink = "erratic-jink"
    orbit_hold = "orbit-hold"
    direct_approach = "direct-approach"
    altitude_step = "altitude-step"
    perimeter_sweep = "perimeter-sweep"


class ScenarioGenerateRequest(BaseModel):
    difficulty: int = Field(ge=1, le=10)
    environment: Environment
    time_of_day: TimeOfDay
    threat_count: ThreatCount
    seed: int | None = None
    # Opt-in grouping: when true, the generated contacts are partitioned into
    # swarms that fly together. Off by default so every existing seed and
    # golden scenario stays byte-identical. Grouping never changes the contact
    # count or the difficulty model.
    swarms: bool = False


class ThreatProfile(BaseModel):
    id: str
    category: str = "unknown_aerial_object"
    classification_label: ClassificationLabel
    expected_response: ExpectedResponse
    spawn_time: float = Field(ge=0)
    speed_class: SpeedClass | None = None
    visibility_class: Visibility | None = None
    flight_pattern: FlightPattern | None = None
    # Swarm membership (observable behavior, never an answer). Contacts sharing
    # a swarm_id fly as one group; swarm_index 0 is the lead. Both fields are
    # optional, so pre-swarm fixtures and persisted scenarios stay valid.
    swarm_id: str | None = None
    swarm_index: int | None = Field(default=None, ge=0)


class Scenario(BaseModel):
    scenario_id: str
    seed: int
    generator_version: str
    difficulty: int = Field(ge=1, le=10)
    environment: Environment
    time_of_day: TimeOfDay
    visibility: Visibility
    sensor_quality: float = Field(ge=0, le=1)
    duration_seconds: float = Field(gt=0)
    threats: list[ThreatProfile]
