"""AI-assisted mode: decision assistant, session labelling, rollup exclusion."""

from __future__ import annotations

import pytest

from app.schemas.assistant import AssistDecision, AssistRequest, AssistStage
from app.services import assistant as assistant_service
from app.services.assistant import LlmAssistant, RuleAssistant, get_assistant


def _request(**overrides) -> AssistRequest:
    base = {
        "stage": "classify",
        "behavior": "steady-transit",
        "cue_clear": True,
    }
    base.update(overrides)
    return AssistRequest(**base)


# --- Rule engine ------------------------------------------------------------


@pytest.mark.parametrize(
    ("behavior", "expected"),
    [
        ("steady-transit", "friendly"),
        ("slow-drift", "civilian"),
        ("erratic", "unknown"),
        ("orbiting", "suspicious"),
        ("direct-approach", "hostile"),
        # An unreadable signature must resolve to the unresolved label, not a
        # guess, and an unknown signature family must be treated the same.
        ("indeterminate", "unknown"),
        ("something-new", "unknown"),
    ],
)
def test_rule_classification_follows_the_published_doctrine(behavior, expected) -> None:
    decision = RuleAssistant().decide(_request(behavior=behavior))
    assert decision == AssistDecision(stage=AssistStage.classify, decision=expected, source="rules")


@pytest.mark.parametrize(
    ("label", "expected"),
    [
        ("friendly", "monitor"),
        ("civilian", "monitor"),
        ("unknown", "track"),
        ("suspicious", "report"),
        ("hostile", "hold"),
    ],
)
def test_rule_response_follows_the_classification(label, expected) -> None:
    decision = RuleAssistant().decide(
        _request(stage="respond", classification=label)
    )
    assert decision == AssistDecision(stage=AssistStage.respond, decision=expected, source="rules")


def test_respond_requires_a_known_classification() -> None:
    with pytest.raises(ValueError):
        _request(stage="respond")
    with pytest.raises(ValueError):
        _request(stage="respond", classification="not-a-label")


def test_decision_vocabulary_is_enforced() -> None:
    with pytest.raises(ValueError):
        AssistDecision(stage=AssistStage.classify, decision="monitor", source="rules")
    with pytest.raises(ValueError):
        AssistDecision(stage=AssistStage.respond, decision="hostile", source="rules")


def test_assisted_requests_cannot_carry_ground_truth_fields() -> None:
    """The request vocabulary is public evidence only."""
    fields = set(AssistRequest.model_fields)
    assert "classification_label" not in fields
    assert "expected_response" not in fields


# --- LLM engine -------------------------------------------------------------


class _FakeResponse:
    def __init__(self, content: str) -> None:
        self._content = content

    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict:
        return {"choices": [{"message": {"content": self._content}}]}


def test_llm_decision_is_parsed_and_tagged() -> None:
    calls: list[dict] = []

    def fake_post(url, json=None, headers=None, timeout=None):
        calls.append({"url": url, "json": json, "headers": headers})
        return _FakeResponse('{"decision": "suspicious"}')

    llm = LlmAssistant("http://llm.local/v1", "test-model", api_key="secret", post=fake_post)
    decision = llm.decide(_request(behavior="orbiting"))
    assert decision.decision == "suspicious"
    assert decision.source == "llm"
    assert calls[0]["url"] == "http://llm.local/v1/chat/completions"
    assert calls[0]["headers"]["Authorization"] == "Bearer secret"
    # Temperature zero: the assistant is a decision aid, not a creativity tool.
    assert calls[0]["json"]["temperature"] == 0


def test_llm_falls_back_on_transport_error() -> None:
    def boom(*args, **kwargs):
        raise RuntimeError("offline")

    llm = LlmAssistant("http://llm.local/v1", "m", post=boom)
    decision = llm.decide(_request(behavior="direct-approach"))
    assert decision == AssistDecision(stage=AssistStage.classify, decision="hostile", source="rules")


@pytest.mark.parametrize(
    "payload",
    [
        '{"decision": "not-a-label"}',  # out of vocabulary
        '{"decision": 7}',  # wrong type
        "not json",
        '{"choice": "hostile"}',  # missing field
    ],
)
def test_llm_falls_back_on_invalid_output(payload: str) -> None:
    llm = LlmAssistant("http://llm.local/v1", "m", post=lambda *a, **k: _FakeResponse(payload))
    decision = llm.decide(_request(behavior="slow-drift"))
    assert decision.source == "rules"
    assert decision.decision == "civilian"


def test_get_assistant_uses_rules_when_unconfigured(monkeypatch) -> None:
    monkeypatch.setattr(assistant_service.config, "LLM_BASE_URL", None)
    monkeypatch.setattr(assistant_service.config, "LLM_MODEL", None)
    assert isinstance(get_assistant(), RuleAssistant)


def test_get_assistant_uses_llm_when_configured(monkeypatch) -> None:
    monkeypatch.setattr(assistant_service.config, "LLM_BASE_URL", "http://llm.local/v1")
    monkeypatch.setattr(assistant_service.config, "LLM_MODEL", "m")
    monkeypatch.setattr(assistant_service.config, "LLM_API_KEY", None)
    assert isinstance(get_assistant(), LlmAssistant)


# --- API --------------------------------------------------------------------


def test_assist_endpoint_classifies(client) -> None:
    response = client.post(
        "/api/v1/assist/decide",
        json={"stage": "classify", "behavior": "orbiting", "cue_clear": True},
    )
    assert response.status_code == 200
    assert response.json() == {"stage": "classify", "decision": "suspicious", "source": "rules"}


def test_assist_endpoint_responds_from_classification(client) -> None:
    response = client.post(
        "/api/v1/assist/decide",
        json={"stage": "respond", "behavior": "direct-approach", "classification": "hostile"},
    )
    assert response.status_code == 200
    assert response.json()["decision"] == "hold"


def test_assist_endpoint_rejects_respond_without_classification(client) -> None:
    response = client.post(
        "/api/v1/assist/decide",
        json={"stage": "respond", "behavior": "direct-approach"},
    )
    assert response.status_code == 422


# --- Session labelling and rollup exclusion ---------------------------------


def _completed_session(client, seed: int, *, ai_assisted: bool, trainee_id: str = "TRAIN-001") -> str:
    scenario = client.post(
        "/api/v1/scenarios/generate",
        json={"difficulty": 3, "environment": "rural", "time_of_day": "day",
              "threat_count": 1, "seed": seed},
    ).json()
    threat = scenario["threats"][0]
    session = client.post(
        "/api/v1/sessions",
        json={
            "trainee_id": trainee_id,
            "scenario_id": scenario["scenario_id"],
            "ai_assisted": ai_assisted,
        },
    ).json()
    sid = session["session_id"]
    base = int(round(threat["spawn_time"] * 1000)) + 500
    for event in (
        {"type": "THREAT_DETECTED", "timestamp_ms": base, "threat_id": threat["id"]},
        {"type": "CLASSIFICATION_SUBMITTED", "timestamp_ms": base + 1000,
         "threat_id": threat["id"], "payload": {"label": threat["classification_label"]}},
        {"type": "RESPONSE_SUBMITTED", "timestamp_ms": base + 2000,
         "threat_id": threat["id"], "payload": {"response": threat["expected_response"]}},
    ):
        client.post(f"/api/v1/sessions/{sid}/events", json=event)
    client.post(f"/api/v1/sessions/{sid}/complete")
    return sid


def test_assisted_session_is_listed_but_excluded_from_performance(client) -> None:
    _completed_session(client, 11, ai_assisted=False)
    _completed_session(client, 12, ai_assisted=True)

    history = client.get("/api/v1/trainees/TRAIN-001/sessions").json()
    assert len(history) == 2
    assert sum(1 for item in history if item["ai_assisted"]) == 1

    performance = client.get("/api/v1/trainees/TRAIN-001/performance").json()
    assert performance["session_count"] == 1
    assert performance["detection_accuracy"] == 100.0


def test_assisted_sessions_are_excluded_from_unit_rollups(client) -> None:
    _completed_session(client, 21, ai_assisted=False)
    _completed_session(client, 22, ai_assisted=True)
    # Unit is attached by the create request; reuse the same unit for both.
    scenario = client.post(
        "/api/v1/scenarios/generate",
        json={"difficulty": 3, "environment": "rural", "time_of_day": "day",
              "threat_count": 1, "seed": 23},
    ).json()
    for ai_assisted in (False, True):
        session = client.post(
            "/api/v1/sessions",
            json={
                "trainee_id": "TRAIN-002",
                "scenario_id": scenario["scenario_id"],
                "unit": "BRAVO-2",
                "ai_assisted": ai_assisted,
            },
        ).json()
        client.post(f"/api/v1/sessions/{session['session_id']}/complete")

    response = client.get("/api/v1/units/BRAVO-2/performance")
    assert response.status_code == 200
    assert response.json()["session_count"] == 1
