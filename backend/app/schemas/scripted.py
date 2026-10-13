"""Schemas for instructor-authored scripted scenarios.

Scripted scenarios reuse the frozen Scenario/ThreatProfile contract for
storage and scoring; only the intake (a key selecting a versioned fixture)
and the listing summary are new.
"""

from __future__ import annotations

from pydantic import BaseModel, Field

from app.schemas.scenario import Environment, TimeOfDay


class ScriptedScenarioRequest(BaseModel):
    scenario_key: str = Field(min_length=1, max_length=64)


class ScriptedScenarioSummary(BaseModel):
    key: str
    title: str
    briefing: str
    difficulty: int = Field(ge=1, le=10)
    environment: Environment
    time_of_day: TimeOfDay
    threat_count: int = Field(ge=1)
