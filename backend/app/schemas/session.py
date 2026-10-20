"""Pydantic models mirroring the frozen v1 session contract.

Source of truth: docs/api/openapi.yaml (SessionCreateRequest, SessionCreated,
CompleteResponse).
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

from app.schemas.scenario import Environment, TimeOfDay


class SessionCreateRequest(BaseModel):
    trainee_id: str
    scenario_id: str
    # Optional unit/platoon grouping for cohort-level performance rollups
    # (SIH outcome: "individual/unit performance over repeated sessions").
    unit: str | None = None
    # Opt-in AI-assisted mode: the decision assistant runs the detection,
    # classification and response loop. Such sessions are labelled and
    # excluded from competency rollups (docs/modules/ai_assisted_mode.md).
    ai_assisted: bool = False


class SessionHistoryItem(BaseModel):
    """One completed session, as listed by GET /trainees/{id}/sessions."""

    session_id: str
    scenario_id: str
    unit: str | None = None
    # True when the session ran in AI-assisted mode. Display-only: excluded
    # from adaptive and unit rollups, still listed in the trainee's history.
    ai_assisted: bool = False
    completed_at: str | None = None
    final_score: float = Field(ge=0, le=100)
    environment: Environment
    time_of_day: TimeOfDay
    difficulty: int = Field(ge=1, le=10)
    threat_count: int = Field(ge=0)


class SessionCreated(BaseModel):
    session_id: str
    status: Literal["active"] = "active"


class CompleteResponse(BaseModel):
    session_id: str
    detection_score: float = Field(ge=0, le=100)
    classification_score: float = Field(ge=0, le=100)
    response_score: float = Field(ge=0, le=100)
    timing_score: float = Field(ge=0, le=100)
    penalty: float = Field(ge=0)
    final_score: float = Field(ge=0, le=100)
    aar_available: bool
    scoring_version: int
