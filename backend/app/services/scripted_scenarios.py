"""Instructor-authored scripted scenarios.

Procedural generation randomizes training; scripted fixtures reproduce exact
training cases for instruction, demonstration, and regression testing. Each
fixture is a versioned JSON document validated by the same validator as
generated scenarios, then persisted through the same ScenarioRow path -- so
scoring, AAR, history, and adaptive training treat scripted and procedural
sessions identically.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

from app.schemas.scenario import Scenario
from app.schemas.scripted import ScriptedScenarioSummary
from app.services.scenario_validator import ScenarioValidationError, validate_scenario

SCRIPTED_DIR = Path(__file__).resolve().parents[1] / "data" / "scripted_scenarios"

_KEY_PATTERN = re.compile(r"^[a-z0-9][a-z0-9_-]*$")


class UnknownScriptedScenarioError(KeyError):
    """Raised when no fixture exists for the requested key."""


def _fixture_path(scenario_key: str) -> Path:
    if not _KEY_PATTERN.match(scenario_key):
        raise UnknownScriptedScenarioError(scenario_key)
    return SCRIPTED_DIR / f"{scenario_key}.json"


def list_scripted() -> list[ScriptedScenarioSummary]:
    """Every available fixture, sorted by key. No validation: listing never
    releases a scenario to a trainee."""
    summaries: list[ScriptedScenarioSummary] = []
    for path in sorted(SCRIPTED_DIR.glob("*.json")):
        data = json.loads(path.read_text(encoding="utf-8"))
        meta = data.get("meta", {})
        summaries.append(
            ScriptedScenarioSummary(
                key=path.stem,
                title=meta.get("title", path.stem),
                briefing=meta.get("briefing", ""),
                difficulty=data["difficulty"],
                environment=data["environment"],
                time_of_day=data["time_of_day"],
                threat_count=len(data["threats"]),
            )
        )
    return summaries


def load_scripted(scenario_key: str) -> Scenario:
    """Load and fully validate one fixture. Deterministic: the same key always
    yields the identical Scenario."""
    try:
        raw = _fixture_path(scenario_key).read_text(encoding="utf-8")
    except OSError as exc:
        raise UnknownScriptedScenarioError(scenario_key) from exc
    try:
        scenario = Scenario(**json.loads(raw))
    except Exception as exc:
        raise ScenarioValidationError(f"fixture {scenario_key!r} is malformed: {exc}") from exc
    validate_scenario(scenario)
    return scenario
