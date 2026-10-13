"""SQLAlchemy engine, session factory, base metadata and lifecycle hooks."""

from __future__ import annotations

from collections.abc import Iterator

from sqlalchemy import create_engine
from sqlalchemy.engine import Engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.config import DATABASE_URL


class Base(DeclarativeBase):
    pass


def _connect_args(url: str) -> dict[str, object]:
    if url.startswith("sqlite"):
        return {"check_same_thread": False}
    return {}


engine = create_engine(DATABASE_URL, connect_args=_connect_args(DATABASE_URL))

SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def _migrate(engine: Engine) -> None:
    """Back-fill schema changes on databases created by an earlier version.

    ``create_all`` only creates tables that do not exist -- it never adds a
    column to an existing table. So adding a column to a model is invisible to
    any developer whose SQLite file predates the change, and the first insert
    fails with "no such column". This project has no migration framework
    (docs/project-management/decisions.md keeps SQLite deliberately simple), so
    additive column changes are applied here instead.

    Runs before ``create_all`` and is idempotent: safe to call on every start.
    """
    if not DATABASE_URL.startswith("sqlite"):
        # PRAGMA is dialect-specific. SQLite is the documented store for the
        # prototype, so other dialects are left to create_all.
        return

    from sqlalchemy import inspect, text

    inspector = inspect(engine)
    if "sessions" not in inspector.get_table_names():
        # Fresh database: create_all will build sessions with the full schema.
        return

    existing = {column["name"] for column in inspector.get_columns("sessions")}
    if "unit" in existing:
        return

    # SQLite ADD COLUMN is cheap and preserves existing rows; the new column is
    # nullable so every existing row stays valid.
    with engine.begin() as connection:
        connection.execute(text("ALTER TABLE sessions ADD COLUMN unit VARCHAR"))


def init_db() -> None:
    from app.db import models  # noqa: F401  (register table metadata)

    _migrate(engine)
    Base.metadata.create_all(bind=engine)


def get_db() -> Iterator[Session]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
