"""ORM models: scenarios, sessions, events, scores, performance_profiles."""

from __future__ import annotations

import json
from datetime import datetime

from sqlalchemy import DateTime, Float, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.database import Base
from app.schemas.events import EventCreateRequest, EventType
from app.schemas.scenario import Scenario, ThreatProfile


class ScenarioRow(Base):
    __tablename__ = "scenarios"

    scenario_id: Mapped[str] = mapped_column(String, primary_key=True)
    seed: Mapped[int] = mapped_column(Integer, nullable=False)
    generator_version: Mapped[str] = mapped_column(String, nullable=False)
    difficulty: Mapped[int] = mapped_column(Integer, nullable=False)
    environment: Mapped[str] = mapped_column(String, nullable=False)
    time_of_day: Mapped[str] = mapped_column(String, nullable=False)
    visibility: Mapped[str] = mapped_column(String, nullable=False)
    sensor_quality: Mapped[float] = mapped_column(Float, nullable=False)
    duration_seconds: Mapped[float] = mapped_column(Float, nullable=False)
    threats_json: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.now)

    @classmethod
    def from_schema(cls, scenario: Scenario) -> "ScenarioRow":
        return cls(
            scenario_id=scenario.scenario_id,
            seed=scenario.seed,
            generator_version=scenario.generator_version,
            difficulty=scenario.difficulty,
            environment=scenario.environment.value,
            time_of_day=scenario.time_of_day.value,
            visibility=scenario.visibility.value,
            sensor_quality=scenario.sensor_quality,
            duration_seconds=scenario.duration_seconds,
            threats_json=json.dumps(
                [threat.model_dump(mode="json") for threat in scenario.threats]
            ),
        )

    def to_schema(self) -> Scenario:
        return Scenario(
            scenario_id=self.scenario_id,
            seed=self.seed,
            generator_version=self.generator_version,
            difficulty=self.difficulty,
            environment=self.environment,
            time_of_day=self.time_of_day,
            visibility=self.visibility,
            sensor_quality=self.sensor_quality,
            duration_seconds=self.duration_seconds,
            threats=[ThreatProfile(**d) for d in json.loads(self.threats_json)],
        )


class SessionRow(Base):
    __tablename__ = "sessions"

    session_id: Mapped[str] = mapped_column(String, primary_key=True)
    trainee_id: Mapped[str] = mapped_column(String, nullable=False)
    scenario_id: Mapped[str] = mapped_column(
        ForeignKey("scenarios.scenario_id"), nullable=False
    )
    # Optional cohort grouping. Nullable so existing rows stay valid and the
    # change stays additive.
    unit: Mapped[str | None] = mapped_column(String, nullable=True, default=None)
    status: Mapped[str] = mapped_column(String, nullable=False, default="active")
    started_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.now)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    final_score: Mapped[float | None] = mapped_column(Float, nullable=True)


class EventRow(Base):
    __tablename__ = "events"

    event_id: Mapped[str] = mapped_column(String, primary_key=True)
    session_id: Mapped[str] = mapped_column(
        ForeignKey("sessions.session_id"), nullable=False
    )
    timestamp_ms: Mapped[int] = mapped_column(Integer, nullable=False)
    type: Mapped[str] = mapped_column(String, nullable=False)
    threat_id: Mapped[str | None] = mapped_column(String, nullable=True)
    payload_json: Mapped[str] = mapped_column(Text, nullable=False, default="{}")


class ScoreRow(Base):
    __tablename__ = "scores"

    session_id: Mapped[str] = mapped_column(
        ForeignKey("sessions.session_id"), primary_key=True
    )
    detection_score: Mapped[float] = mapped_column(Float, nullable=False)
    classification_score: Mapped[float] = mapped_column(Float, nullable=False)
    response_score: Mapped[float] = mapped_column(Float, nullable=False)
    timing_score: Mapped[float] = mapped_column(Float, nullable=False)
    penalty: Mapped[float] = mapped_column(Float, nullable=False)
    final_score: Mapped[float] = mapped_column(Float, nullable=False)
    scoring_version: Mapped[int] = mapped_column(Integer, nullable=False)


class PerformanceProfileRow(Base):
    __tablename__ = "performance_profiles"

    trainee_id: Mapped[str] = mapped_column(String, primary_key=True)
    session_count: Mapped[int] = mapped_column(Integer, default=0)
    detection_accuracy: Mapped[float] = mapped_column(Float, default=0.0)
    classification_accuracy: Mapped[float] = mapped_column(Float, default=0.0)
    response_accuracy: Mapped[float] = mapped_column(Float, default=0.0)
    average_reaction_time_ms: Mapped[float | None] = mapped_column(Float, nullable=True)
    night_score: Mapped[float | None] = mapped_column(Float, nullable=True)
    day_score: Mapped[float | None] = mapped_column(Float, nullable=True)
    multi_threat_score: Mapped[float | None] = mapped_column(Float, nullable=True)
    low_visibility_score: Mapped[float | None] = mapped_column(Float, nullable=True)
    urban_score: Mapped[float | None] = mapped_column(Float, nullable=True)
    rural_score: Mapped[float | None] = mapped_column(Float, nullable=True)
    clear_visibility_score: Mapped[float | None] = mapped_column(Float, nullable=True)
    reduced_visibility_score: Mapped[float | None] = mapped_column(Float, nullable=True)
    poor_visibility_score: Mapped[float | None] = mapped_column(Float, nullable=True)
    high_sensor_score: Mapped[float | None] = mapped_column(Float, nullable=True)
    medium_sensor_score: Mapped[float | None] = mapped_column(Float, nullable=True)
    low_sensor_score: Mapped[float | None] = mapped_column(Float, nullable=True)
    current_level: Mapped[int] = mapped_column(Integer, default=1)


def event_row_to_request(row: EventRow) -> EventCreateRequest:
    return EventCreateRequest(
        type=EventType(row.type),
        timestamp_ms=row.timestamp_ms,
        threat_id=row.threat_id,
        payload=json.loads(row.payload_json),
    )
