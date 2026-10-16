"""Public (redacted) scenario view for the trainee client.

The frozen v1 Scenario contract carries ground truth (classification labels
and expected responses) because the server needs it for scoring. The trainee
client must never receive those answers, so this module defines a separate
schema: kinematics plus observable cues only. The Scenario contract itself is
left untouched (docs/api/openapi.yaml: Scenario, ThreatProfile).
"""

from __future__ import annotations

from pydantic import BaseModel, Field

from app.schemas.scenario import Environment, FlightPattern, SpeedClass, TimeOfDay, Visibility


class PublicThreat(BaseModel):
    id: str
    spawn_time: float = Field(ge=0)
    speed_class: SpeedClass | None = None
    visibility_class: Visibility | None = None
    # Assigned trajectory, trainee-visible like behavior: observable motion,
    # never an answer (patterns are label-independent by construction).
    flight_pattern: FlightPattern | None = None
    # Observable behavior signature derived from ground truth
    # (services/observation_cues.py). Never the classification itself.
    behavior: str
    # True when conditions allowed a clean read; False means "indeterminate".
    cue_clear: bool


class PublicScenario(BaseModel):
    scenario_id: str
    seed: int
    observation_version: str
    difficulty: int = Field(ge=1, le=10)
    environment: Environment
    time_of_day: TimeOfDay
    visibility: Visibility
    sensor_quality: float = Field(ge=0, le=1)
    duration_seconds: float = Field(gt=0)
    threats: list[PublicThreat]
    # Shared recognition doctrine: what each behavior generally suggests.
    # This is the same for every scenario, so it teaches signatures without
    # revealing any contact's answer.
    cue_legend: dict[str, str]
