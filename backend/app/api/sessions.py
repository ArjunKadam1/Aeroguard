"""Session lifecycle HTTP routes: create, record events, complete."""

from __future__ import annotations

import json
import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.db.database import get_db
from app.db.models import (
    EventRow,
    ScenarioRow,
    ScoreRow,
    SessionRow,
    event_row_to_request,
)
from app.schemas.events import EventCreateRequest, EventCreated, EventType
from app.schemas.session import (
    CompleteResponse,
    SessionCreateRequest,
    SessionCreated,
)
from app.services.scoring import score_v2

router = APIRouter(tags=["sessions"])

_EVENT_ID_MAX_ATTEMPTS = 3


def _new_session_id() -> str:
    return f"SES-{uuid.uuid4().hex[:8].upper()}"


def _new_event_id() -> str:
    # Collision-safe without a read-modify-write cycle: the old
    # count()+1 scheme raced under concurrent submissions, and only a retry
    # loop masked it.
    return f"EVT-{uuid.uuid4().hex[:12].upper()}"


def _threat_ids(scenario: ScenarioRow) -> set[str]:
    return {threat["id"] for threat in json.loads(scenario.threats_json)}


def _threat_spawn_ms(scenario: ScenarioRow, threat_id: str) -> int | None:
    for threat in json.loads(scenario.threats_json):
        if threat["id"] == threat_id:
            return int(round(float(threat["spawn_time"]) * 1000))
    return None


@router.post("/sessions", response_model=SessionCreated, status_code=201)
def create_session(
    body: SessionCreateRequest, db: Session = Depends(get_db)
) -> SessionCreated:
    scenario = db.get(ScenarioRow, body.scenario_id)
    if scenario is None:
        raise HTTPException(
            status_code=404, detail=f"unknown scenario_id: {body.scenario_id}"
        )
    session = SessionRow(
        session_id=_new_session_id(),
        trainee_id=body.trainee_id,
        scenario_id=body.scenario_id,
        unit=body.unit,
        status="active",
    )
    db.add(session)
    db.commit()
    return SessionCreated(session_id=session.session_id, status="active")


@router.post(
    "/sessions/{session_id}/events", response_model=EventCreated, status_code=201
)
def submit_event(
    session_id: str, body: EventCreateRequest, db: Session = Depends(get_db)
) -> EventCreated:
    session = db.get(SessionRow, session_id)
    if session is None:
        raise HTTPException(status_code=404, detail=f"unknown session_id: {session_id}")
    if session.status == "completed":
        raise HTTPException(status_code=422, detail="session already completed")

    if body.threat_id is not None:
        scenario = db.get(ScenarioRow, session.scenario_id)
        if scenario is None or body.threat_id not in _threat_ids(scenario):
            raise HTTPException(
                status_code=422, detail=f"unknown threat_id: {body.threat_id}"
            )

    # The client owns the clock, but the server owns the rules: timestamps must
    # be monotonic, threat decisions cannot predate the spawn, and the
    # detect -> classify -> respond order is enforced here rather than trusted
    # from the browser (which holds the scenario answers).
    prior = (
        db.query(EventRow)
        .filter(EventRow.session_id == session_id)
        .all()
    )
    if prior and body.timestamp_ms < max(row.timestamp_ms for row in prior):
        raise HTTPException(
            status_code=422, detail="event timestamp is older than the last recorded event"
        )

    if body.threat_id is not None and body.type in (
        EventType.THREAT_DETECTED,
        EventType.CLASSIFICATION_SUBMITTED,
        EventType.RESPONSE_SUBMITTED,
    ):
        spawn_ms = _threat_spawn_ms(scenario, body.threat_id)
        if spawn_ms is not None and body.timestamp_ms < spawn_ms:
            raise HTTPException(
                status_code=422,
                detail=f"event predates spawn of {body.threat_id}",
            )
        prior_types = {row.type for row in prior if row.threat_id == body.threat_id}
        if (
            body.type == EventType.CLASSIFICATION_SUBMITTED
            and EventType.THREAT_DETECTED not in prior_types
        ):
            raise HTTPException(
                status_code=422, detail="classification requires a prior detection"
            )
        if (
            body.type == EventType.RESPONSE_SUBMITTED
            and EventType.CLASSIFICATION_SUBMITTED not in prior_types
        ):
            raise HTTPException(
                status_code=422, detail="response requires a prior classification"
            )

    for attempt in range(_EVENT_ID_MAX_ATTEMPTS):
        event = EventRow(
            event_id=_new_event_id(),
            session_id=session_id,
            timestamp_ms=body.timestamp_ms,
            type=body.type.value,
            threat_id=body.threat_id,
            payload_json=json.dumps(body.payload),
        )
        db.add(event)
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
            if attempt == _EVENT_ID_MAX_ATTEMPTS - 1:
                raise
            continue
        return EventCreated(event_id=event.event_id, accepted=True)


@router.post("/sessions/{session_id}/complete", response_model=CompleteResponse)
def complete_session(
    session_id: str, db: Session = Depends(get_db)
) -> CompleteResponse:
    session = db.get(SessionRow, session_id)
    if session is None:
        raise HTTPException(status_code=404, detail=f"unknown session_id: {session_id}")

    existing = db.get(ScoreRow, session_id)
    if existing is not None:
        return CompleteResponse(
            session_id=session_id,
            detection_score=existing.detection_score,
            classification_score=existing.classification_score,
            response_score=existing.response_score,
            timing_score=existing.timing_score,
            penalty=existing.penalty,
            final_score=existing.final_score,
            aar_available=True,
            scoring_version=existing.scoring_version,
        )

    scenario_row = db.get(ScenarioRow, session.scenario_id)
    if scenario_row is None:
        raise HTTPException(
            status_code=404, detail=f"unknown scenario_id: {session.scenario_id}"
        )
    event_rows = (
        db.query(EventRow)
        .filter(EventRow.session_id == session_id)
        .order_by(EventRow.timestamp_ms, EventRow.event_id)
        .all()
    )
    events = [event_row_to_request(row) for row in event_rows]

    # Derive misses at completion: every threat with no recorded detection gets
    # a THREAT_MISSED event stamped at session end, so the timeline and AAR
    # show misses explicitly instead of inferring them from silence.
    detected_ids = {
        event.threat_id
        for event in events
        if event.type == EventType.THREAT_DETECTED and event.threat_id is not None
    }
    end_ms = int(round(scenario_row.to_schema().duration_seconds * 1000))
    for threat in json.loads(scenario_row.threats_json):
        if threat["id"] not in detected_ids:
            missed = EventRow(
                event_id=_new_event_id(),
                session_id=session_id,
                timestamp_ms=end_ms,
                type=EventType.THREAT_MISSED.value,
                threat_id=threat["id"],
                payload_json="{}",
            )
            db.add(missed)
            events.append(event_row_to_request(missed))
    db.commit()

    result = score_v2(session_id, scenario_row.to_schema(), events)

    db.add(
        ScoreRow(
            session_id=session_id,
            detection_score=result.detection_score,
            classification_score=result.classification_score,
            response_score=result.response_score,
            timing_score=result.timing_score,
            penalty=result.penalty,
            final_score=result.final_score,
            scoring_version=result.scoring_version,
        )
    )
    session.status = "completed"
    session.completed_at = datetime.now()
    session.final_score = result.final_score
    db.commit()

    return CompleteResponse(
        session_id=session_id,
        detection_score=result.detection_score,
        classification_score=result.classification_score,
        response_score=result.response_score,
        timing_score=result.timing_score,
        penalty=result.penalty,
        final_score=result.final_score,
        aar_available=True,
        scoring_version=result.scoring_version,
    )
