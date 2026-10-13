from pathlib import Path

import yaml

CONTRACT = Path(__file__).resolve().parents[2] / "docs" / "api" / "openapi.yaml"

EXPECTED_PATHS = {
    "/api/v1/scenarios/generate",
    "/api/v1/scenarios/{scenario_id}/view",
    "/api/v1/scenarios/scripted",
    "/api/v1/sessions",
    "/api/v1/sessions/{session_id}/events",
    "/api/v1/sessions/{session_id}/complete",
    "/api/v1/sessions/{session_id}/aar",
    "/api/v1/trainees/{trainee_id}/performance",
    "/api/v1/training/recommend",
}

EXPECTED_SCHEMAS = {
    "ScenarioGenerateRequest",
    "Scenario",
    "ThreatProfile",
    "PublicScenario",
    "PublicThreat",
    "ScriptedScenarioRequest",
    "ScriptedScenarioSummary",
    "SessionCreateRequest",
    "SessionCreated",
    "EventCreateRequest",
    "EventCreated",
    "CompleteResponse",
    "ScoreResult",
    "TimingMetrics",
    "Mistake",
    "AAR",
    "GroundTruthItem",
    "PerformanceProfile",
    "RecommendRequest",
    "RecommendResponse",
}


def _spec() -> dict:
    assert CONTRACT.exists(), f"contract missing: {CONTRACT}"
    return yaml.safe_load(CONTRACT.read_text(encoding="utf-8"))


def test_contract_is_openapi_3() -> None:
    spec = _spec()
    assert spec["openapi"].startswith("3.")
    assert spec["info"]["title"] == "Aeroguard API"


def test_contract_lists_all_v1_endpoints() -> None:
    spec = _spec()
    assert EXPECTED_PATHS <= set(spec["paths"])


def test_contract_defines_core_schemas() -> None:
    spec = _spec()
    assert EXPECTED_SCHEMAS <= set(spec["components"]["schemas"])


def _collect_refs(node, acc=None):
    if acc is None:
        acc = set()
    if isinstance(node, dict):
        for key, value in node.items():
            if key == "$ref" and isinstance(value, str):
                acc.add(value)
            else:
                _collect_refs(value, acc)
    elif isinstance(node, list):
        for item in node:
            _collect_refs(item, acc)
    return acc


def test_contract_refs_resolve() -> None:
    spec = _spec()
    refs = _collect_refs(spec)
    assert refs, "contract should contain at least one $ref"
    for ref in refs:
        assert ref.startswith("#/"), f"external ref not allowed: {ref}"
        node = spec
        for part in ref[2:].split("/"):
            assert part in node, f"dangling ref: {ref}"
            node = node[part]
