"""Performance aggregation and adaptive recommendation routes.

    GET  /trainees/{trainee_id}/performance
    GET  /trainees/{trainee_id}/sessions
    GET  /units/{unit}/performance
    POST /training/recommend

Routes stay thin: they assemble plain SessionSummary values from the DB and
delegate all logic to the pure services.adaptive / services.unit_stats
functions.
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
from app.schemas.session import SessionHistoryItem
from app.services.unit_stats import UnitPerformance, rollup_unit
from app.services.adaptive import (
    RecommendInput,
    SessionSummary,
    aggregate_performance,
    build_recommendation,
    mean,
    resolve_current_level,
)

router = APIRouter(tags=["training"])


def _completed_sessions(
    db: Session, trainee_id: str, include_assisted: bool = False
) -> list[SessionRow]:
    """Completed sessions for a trainee, oldest first.

    AI-assisted sessions are excluded by default: they are demonstrations of
    the assistant, not competency evidence, so adaptive level, recommendations
    and unit rollups never see them. The trainee's own history passes
    include_assisted=True to list them with their label.
    """
    query = db.query(SessionRow).filter(
        SessionRow.trainee_id == trainee_id, SessionRow.status == "completed"
    )
    if not include_assisted:
        query = query.filter(SessionRow.ai_assisted.is_(False))
    return query.order_by(SessionRow.completed_at, SessionRow.session_id).all()


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


def _observation_evidence(
    scenario: ScenarioRow, session_id: str, db: Session
) -> tuple[float | None, float | None]:
    """(mean spawn->detection ms, share of detections via radar-only tracks).

    Read from stored scenario spawns plus the sensor provenance the client
    attaches to detection events. Display-only evidence for recommendations;
    scoring never sees it.
    """
    rows = (
        db.query(EventRow)
        .filter(EventRow.session_id == session_id)
        .order_by(EventRow.timestamp_ms, EventRow.event_id)
        .all()
    )
    events = [event_row_to_request(row) for row in rows]
    spawns = {
        threat["id"]: int(round(float(threat["spawn_time"]) * 1000))
        for threat in json.loads(scenario.threats_json)
    }
    acquisitions: list[float] = []
    radar_detections = 0
    detected = 0
    for event in events:
        if event.type != EventType.THREAT_DETECTED or event.threat_id is None:
            continue
        detected += 1
        spawn_ms = spawns.get(event.threat_id)
        if spawn_ms is not None:
            acquisitions.append(float(max(0, event.timestamp_ms - spawn_ms)))
        if event.payload.get("sensor") == "radar":
            radar_detections += 1
    share = (radar_detections / detected) if detected else None
    return mean(acquisitions), share


def _summary(db: Session, session: SessionRow) -> SessionSummary | None:
    score = db.get(ScoreRow, session.session_id)
    scenario = db.get(ScenarioRow, session.scenario_id)
    if score is None or scenario is None:
        return None
    acquisition_ms, radar_share = _observation_evidence(scenario, session.session_id, db)
    return SessionSummary(
        final_score=score.final_score,
        detection_score=score.detection_score,
        classification_score=score.classification_score,
        response_score=score.response_score,
        timing_score=score.timing_score,
        environment=scenario.environment,
        time_of_day=scenario.time_of_day,
        visibility=scenario.visibility,
        threat_count=len(json.loads(scenario.threats_json)),
        average_reaction_ms=_average_reaction_ms(db, session.session_id),
        sensor_quality=scenario.sensor_quality,
        difficulty=scenario.difficulty,
        mean_acquisition_ms=acquisition_ms,
        radar_detection_share=radar_share,
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
        mean_acquisition_ms=mean(
            [summary.mean_acquisition_ms for summary in summaries
             if summary.mean_acquisition_ms is not None]
        ),
        radar_detection_share=mean(
            [summary.radar_detection_share for summary in summaries
             if summary.radar_detection_share is not None]
        ),
    )
    response = build_recommendation(data)
    profile.current_level = response.recommended_difficulty
    _upsert_profile(db, profile)
    return response


def _session_summaries(db: Session, trainee_id: str) -> list[SessionSummary]:
    return _summaries(db, trainee_id)


@router.get("/trainees/{trainee_id}/sessions", response_model=list[SessionHistoryItem])
def list_trainee_sessions(
    trainee_id: str, db: Session = Depends(get_db)
) -> list[SessionHistoryItem]:
    """Completed sessions for a trainee, newest first.

    Powers the dashboard's session history. Without this there is no endpoint
    that can list past sessions at all, so no history view can exist.
    """
    _require_trainee(db, trainee_id)
    rows = _completed_sessions(db, trainee_id, include_assisted=True)
    items: list[SessionHistoryItem] = []
    for row in rows:
        score = db.get(ScoreRow, row.session_id)
        scenario = db.get(ScenarioRow, row.scenario_id)
        if score is None or scenario is None:
            continue
        items.append(
            SessionHistoryItem(
                session_id=row.session_id,
                scenario_id=row.scenario_id,
                unit=row.unit,
                ai_assisted=bool(row.ai_assisted),
                completed_at=row.completed_at.isoformat() if row.completed_at else None,
                final_score=score.final_score,
                environment=scenario.environment,
                time_of_day=scenario.time_of_day,
                difficulty=scenario.difficulty,
                threat_count=len(json.loads(scenario.threats_json)),
            )
        )
    # _completed_sessions orders ascending by completed_at; the dashboard wants
    # most recent first.
    items.reverse()
    return items


@router.get("/units/{unit}/performance", response_model=UnitPerformance)
def unit_performance(
    unit: str, db: Session = Depends(get_db)
) -> UnitPerformance:
    """Aggregate performance across every completed session in a unit.

    AI-assisted sessions are demos of the assistant, not competency evidence,
    so they are excluded from the rollup like everywhere else.
    """
    sessions = (
        db.query(SessionRow)
        .filter(
            SessionRow.unit == unit,
            SessionRow.status == "completed",
            SessionRow.ai_assisted.is_(False),
        )
        .order_by(SessionRow.completed_at, SessionRow.session_id)
        .all()
    )
    if not sessions:
        raise HTTPException(status_code=404, detail=f"unknown unit: {unit}")

    summaries: list[SessionSummary] = []
    for row in sessions:
        score = db.get(ScoreRow, row.session_id)
        scenario = db.get(ScenarioRow, row.scenario_id)
        if score is None or scenario is None:
            continue
        acquisition_ms, radar_share = _observation_evidence(scenario, row.session_id, db)
        summaries.append(
            SessionSummary(
                final_score=score.final_score,
                detection_score=score.detection_score,
                classification_score=score.classification_score,
                response_score=score.response_score,
                timing_score=score.timing_score,
                environment=scenario.environment,
                time_of_day=scenario.time_of_day,
                visibility=scenario.visibility,
                threat_count=len(json.loads(scenario.threats_json)),
                average_reaction_ms=_average_reaction_ms(db, row.session_id),
                sensor_quality=scenario.sensor_quality,
                difficulty=scenario.difficulty,
                mean_acquisition_ms=acquisition_ms,
                radar_detection_share=radar_share,
            )
        )

    distinct_trainees = {row.trainee_id for row in sessions}
    # Reuse the adaptive aggregator so unit condition scores are computed
    # identically to the per-trainee view.
    profile = aggregate_performance(unit, summaries, 1)
    condition_scores = {
        "day_score": profile.day_score,
        "night_score": profile.night_score,
        "multi_threat_score": profile.multi_threat_score,
        "urban_score": profile.urban_score,
        "rural_score": profile.rural_score,
        "clear_visibility_score": profile.clear_visibility_score,
        "reduced_visibility_score": profile.reduced_visibility_score,
        "poor_visibility_score": profile.poor_visibility_score,
    }
    return rollup_unit(unit, summaries, condition_scores, len(distinct_trainees))
