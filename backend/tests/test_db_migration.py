from __future__ import annotations

from sqlalchemy import create_engine, inspect, text

from app.db.database import Base, _migrate, init_db


def _session_columns(engine) -> set[str]:
    return {c["name"] for c in inspect(engine).get_columns("sessions")}


def test_fresh_database_has_the_unit_column() -> None:
    """Regression: a fresh DB must include every current column."""
    engine = create_engine("sqlite://")
    Base.metadata.create_all(bind=engine)
    assert "unit" in _session_columns(engine)


def test_migration_adds_unit_to_an_older_database() -> None:
    """The exact failure: a DB created before `unit` existed must be upgraded.

    Without this, inserting a session against an older file raises
    "table sessions has no column named unit" (SQLAlchemy OperationalError).
    """
    engine = create_engine("sqlite://")
    # Simulate the pre-migration schema: sessions without the unit column.
    with engine.begin() as connection:
        connection.execute(
            text(
                "CREATE TABLE sessions ("
                "session_id VARCHAR PRIMARY KEY, "
                "trainee_id VARCHAR NOT NULL, "
                "scenario_id VARCHAR NOT NULL, "
                "status VARCHAR NOT NULL, "
                "started_at DATETIME, "
                "completed_at DATETIME, "
                "final_score FLOAT)"
            )
        )
    assert "unit" not in _session_columns(engine)

    _migrate(engine)
    assert "unit" in _session_columns(engine)

    # The column must be usable, and pre-existing rows must remain readable.
    with engine.begin() as connection:
        connection.execute(
            text(
                "INSERT INTO sessions (session_id, trainee_id, scenario_id, status) "
                "VALUES ('SES-OLD', 'T1', 'SCN-1', 'completed')"
            )
        )
        connection.execute(
            text(
                "INSERT INTO sessions "
                "(session_id, trainee_id, scenario_id, status, unit) "
                "VALUES ('SES-NEW', 'T2', 'SCN-1', 'active', 'ALPHA-1')"
            )
        )
        rows = connection.execute(
            text("SELECT session_id, unit FROM sessions ORDER BY session_id")
        ).fetchall()
    assert rows == [("SES-NEW", "ALPHA-1"), ("SES-OLD", None)]


def test_migration_is_idempotent() -> None:
    """init_db runs on every start; re-running must not error."""
    engine = create_engine("sqlite://")
    Base.metadata.create_all(bind=engine)
    _migrate(engine)
    _migrate(engine)
    _migrate(engine)
    assert "unit" in _session_columns(engine)


def test_migration_skips_when_sessions_table_absent() -> None:
    """A brand new database is create_all's job, not the migration's."""
    engine = create_engine("sqlite://")
    _migrate(engine)
    # The migration must not create the table itself, nor raise.
    assert "sessions" not in inspect(engine).get_table_names()


def test_migration_is_safe_on_the_real_engine() -> None:
    """Smoke test against the configured engine, using the real init path."""
    init_db()
    init_db()
    from app.db.database import engine

    assert "unit" in _session_columns(engine)