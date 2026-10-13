"""Scenario generation HTTP route (POST /scenarios/generate)."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.db.database import get_db
from app.db.models import ScenarioRow
from app.schemas.observation import PublicScenario
from app.schemas.scenario import Scenario, ScenarioGenerateRequest
from app.schemas.scripted import ScriptedScenarioRequest, ScriptedScenarioSummary
from app.services.anti_repetition import (
    RecentConfigTracker,
    generate_with_anti_repetition,
)
from app.services.scenario_generator import InfeasibleScenarioError
from app.services.observation_cues import build_public_scenario
from app.services.scenario_validator import ScenarioValidationError, validate_scenario
from app.services.scripted_scenarios import (
    UnknownScriptedScenarioError,
    list_scripted,
    load_scripted,
)

router = APIRouter(tags=["scenarios"])


@router.get("/scenarios/scripted", response_model=list[ScriptedScenarioSummary])
def list_scripted_route() -> list[ScriptedScenarioSummary]:
    """Catalog of instructor-authored scripted scenarios."""
    return list_scripted()


@router.post("/scenarios/scripted", response_model=Scenario)
def create_scripted_route(body: ScriptedScenarioRequest, db: Session = Depends(get_db)) -> Scenario:
    """Release a scripted fixture as a playable scenario.

    The fixture is validated exactly like a generated scenario and persisted
    through the same path, so downstream scoring, AAR, and history are
    identical for scripted and procedural sessions.
    """
    try:
        scenario = load_scripted(body.scenario_key)
    except UnknownScriptedScenarioError as exc:
        raise HTTPException(status_code=404, detail=f"unknown scenario_key: {body.scenario_key}") from exc
    except ScenarioValidationError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    existing = db.get(ScenarioRow, scenario.scenario_id)
    if existing is not None:
        stored = existing.to_schema()
        validate_scenario(stored)
        return stored
    db.add(ScenarioRow.from_schema(scenario))
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
    return scenario


@router.post("/scenarios/generate", response_model=Scenario)
def generate_scenario_route(
    body: ScenarioGenerateRequest,
    request: Request,
    db: Session = Depends(get_db),
) -> Scenario:
    tracker: RecentConfigTracker = request.app.state.recent_configs
    try:
        scenario = generate_with_anti_repetition(body, tracker)
        validate_scenario(scenario)
        existing = db.get(ScenarioRow, scenario.scenario_id)
        if existing is not None:
            stored = existing.to_schema()
            validate_scenario(stored)
            return stored
    except (InfeasibleScenarioError, ScenarioValidationError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    db.add(ScenarioRow.from_schema(scenario))
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
    return scenario


@router.get("/scenarios/{scenario_id}/view", response_model=PublicScenario)
def scenario_view(scenario_id: str, db: Session = Depends(get_db)) -> PublicScenario:
    """Redacted trainee view of a stored scenario.

    The frozen Scenario contract keeps ground truth for server-side scoring;
    this separate route serves kinematics plus observable cues only, so the
    browser never receives classification labels or expected responses.
    """
    row = db.get(ScenarioRow, scenario_id)
    if row is None:
        raise HTTPException(status_code=404, detail=f"unknown scenario_id: {scenario_id}")
    return build_public_scenario(row.to_schema())
