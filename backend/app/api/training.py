"""Performance aggregation and adaptive recommendation routes.

    GET  /trainees/{trainee_id}/performance
    POST /training/recommend

Routes stay thin: they assemble plain SessionSummary values from the DB and
delegate all logic to the pure services.adaptive functions.
"""

from __future__ import annotations

import json

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.db.database import get_db
from app.db.models import (
    EventRow,
    PerformanceProfileRow,
    ScenarioRow,
    ScoreRow,
    SessionRow,
    event_row_to_request,
)
from app.schemas.aar import PerformanceProfile, RecommendRequest, RecommendResponse
from app.schemas.events import EventType
from app.services.adaptive import (
    RecommendInput,
    SessionSummary,
    aggregate_performance,
    build_recommendation,
    mean,
    resolve_current_level,
)

router = APIRouter(tags=["training"])


def _completed_sessions(db: Session, trainee_id: str) -> list[SessionRow]:
    return (
        db.query(SessionRow)
        .filter(SessionRow.trainee_id == trainee_id, SessionRow.status == "completed")
        .order_by(SessionRow.completed_at, SessionRow.session_id)
        .all()
    )


def _average_reaction_ms(db: Session, session_id: str) -> float | None:
    rows = (
        db.query(EventRow)
        .filter(EventRow.session_id == session_id)
        .order_by(EventRow.timestamp_ms, EventRow.event_id)
        .all()
    )
    events = [event_row_to_request(row) for row in rows]
    latencies: list[float] = []
    for event in events:
        if event.type != EventType.THREAT_DETECTED or event.threat_id is None:
            continue
        response = next(
            (
                candidate
                for candidate in events
                if candidate.type == EventType.RESPONSE_SUBMITTED
                and candidate.threat_id == event.threat_id
            ),
            None,
        )
        if response is not None:
            latencies.append(float(max(0, response.timestamp_ms - event.timestamp_ms)))
    return mean(latencies)


def _summary(db: Session, session: SessionRow) -> SessionSummary | None:
    score = db.get(ScoreRow, session.session_id)
    scenario = db.get(ScenarioRow, session.scenario_id)
    if score is None or scenario is None:
        return None
    return SessionSummary(
        final_score=score.final_score,
        detection_score=score.detection_score,
        classification_score=score.classification_score,
        response_score=score.response_score,
        environment=scenario.environment,
        time_of_day=scenario.time_of_day,
        visibility=scenario.visibility,
        threat_count=len(json.loads(scenario.threats_json)),
        average_reaction_ms=_average_reaction_ms(db, session.session_id),
        sensor_quality=scenario.sensor_quality,
        difficulty=scenario.difficulty,
    )


def _summaries(db: Session, trainee_id: str) -> list[SessionSummary]:
    return [
        summary
        for summary in (_summary(db, row) for row in _completed_sessions(db, trainee_id))
        if summary is not None
    ]


def _require_trainee(db: Session, trainee_id: str) -> None:
    exists = db.query(SessionRow).filter(SessionRow.trainee_id == trainee_id).first()
    if exists is None:
        raise HTTPException(status_code=404, detail=f"unknown trainee_id: {trainee_id}")


def _current_level(db: Session, trainee_id: str, sessions: list[SessionSummary]) -> int:
    profile = db.get(PerformanceProfileRow, trainee_id)
    stored = profile.current_level if profile is not None else None
    return resolve_current_level(stored, sessions)


def _upsert_profile(db: Session, profile: PerformanceProfile) -> None:
    row = db.get(PerformanceProfileRow, profile.trainee_id)
    if row is None:
        row = PerformanceProfileRow(trainee_id=profile.trainee_id)
        db.add(row)
    row.session_count = profile.session_count
    row.detection_accuracy = profile.detection_accuracy
    row.classification_accuracy = profile.classification_accuracy
    row.response_accuracy = profile.response_accuracy
    row.average_reaction_time_ms = profile.average_reaction_time_ms
    row.night_score = profile.night_score
    row.day_score = profile.day_score
    row.multi_threat_score = profile.multi_threat_score
    row.low_visibility_score = profile.low_visibility_score
    row.urban_score = profile.urban_score
    row.rural_score = profile.rural_score
    row.clear_visibility_score = profile.clear_visibility_score
    row.reduced_visibility_score = profile.reduced_visibility_score
    row.poor_visibility_score = profile.poor_visibility_score
    row.high_sensor_score = profile.high_sensor_score
    row.medium_sensor_score = profile.medium_sensor_score
    row.low_sensor_score = profile.low_sensor_score
    row.current_level = profile.current_level
    db.commit()


@router.get("/trainees/{trainee_id}/performance", response_model=PerformanceProfile)
def get_performance(trainee_id: str, db: Session = Depends(get_db)) -> PerformanceProfile:
    _require_trainee(db, trainee_id)
    summaries = _summaries(db, trainee_id)
    level = _current_level(db, trainee_id, summaries)
    profile = aggregate_performance(trainee_id, summaries, level)
    _upsert_profile(db, profile)
    return profile


@router.post("/training/recommend", response_model=RecommendResponse)
def recommend_training(
    body: RecommendRequest, db: Session = Depends(get_db)
) -> RecommendResponse:
    _require_trainee(db, body.trainee_id)
    summaries = _summaries(db, body.trainee_id)
    level = _current_level(db, body.trainee_id, summaries)
    profile = aggregate_performance(body.trainee_id, summaries, level)
    last = summaries[-1] if summaries else None
    data = RecommendInput(
        recent_final_scores=[summary.final_score for summary in summaries],
        overall_score=mean([summary.final_score for summary in summaries]),
        night_score=profile.night_score,
        multi_threat_score=profile.multi_threat_score,
        last_environment=last.environment if last else "urban",
        last_time_of_day=last.time_of_day if last else "day",
        last_threat_count=last.threat_count if last else 1,
        current_level=level,
        urban_score=profile.urban_score,
        rural_score=profile.rural_score,
        reduced_visibility_score=profile.reduced_visibility_score,
        poor_visibility_score=profile.poor_visibility_score,
        low_sensor_score=profile.low_sensor_score,
    )
    response = build_recommendation(data)
    profile.current_level = response.recommended_difficulty
    _upsert_profile(db, profile)
    return response
