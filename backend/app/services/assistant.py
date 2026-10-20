"""Optional AI decision assistant: rule-based by default, LLM when configured.

The assistant answers one abstract decision per request from trainee-visible
evidence only -- never the hidden classification label or expected response.
Two engines sit behind one interface:

- ``RuleAssistant``: deterministic, offline, and the always-available
  fallback. It maps the observable behavior family through the published
  recognition doctrine. An unreadable signature ("indeterminate") resolves to
  the "unknown" label, so the assistant is allowed to be unsure rather than
  guessing an identity the sensors did not resolve.
- ``LlmAssistant``: optional OpenAI-compatible /chat/completions endpoint,
  provider-agnostic, same env configuration as the AAR narrator. Its output is
  validated against the fixed decision vocabulary and any error, timeout, or
  out-of-vocabulary answer degrades to the rule engine, so the mode keeps
  working offline.

Safety: only the abstract training vocabulary ever leaves this module, and it
never names a real action, platform, or real-world operation. Assisted decisions
still travel the normal session gates on the client and assisted sessions are
excluded from competency scoring.

Source of truth: docs/modules/ai_assisted_mode.md.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from typing import Any, Protocol

import httpx

from app import config
from app.schemas.assistant import AssistDecision, AssistRequest, AssistStage

# Observable behavior signature -> best-supported label. The vocabulary is the
# published cue legend, so this mapping is the same doctrine the trainee is
# taught; an unreadable signature resolves to "unknown".
_BEHAVIOR_TO_LABEL: dict[str, str] = {
    "steady-transit": "friendly",
    "slow-drift": "civilian",
    "erratic": "unknown",
    "orbiting": "suspicious",
    "direct-approach": "hostile",
}

# Classification -> abstract response, mirroring the trainee-visible doctrine:
# monitor known-friendly/civilian traffic, track an unresolved identity, report
# suspicious behavior, hold on a hostile classification.
_LABEL_TO_RESPONSE: dict[str, str] = {
    "friendly": "monitor",
    "civilian": "monitor",
    "unknown": "track",
    "suspicious": "report",
    "hostile": "hold",
}

_INDETERMINATE = "indeterminate"


class Assistant(Protocol):
    def decide(self, request: AssistRequest) -> AssistDecision: ...


class RuleAssistant:
    """Deterministic, offline engine; never reads ground truth."""

    def decide(self, request: AssistRequest) -> AssistDecision:
        if request.stage is AssistStage.classify:
            return AssistDecision(
                stage=request.stage,
                decision=self._classify(request),
                source="rules",
            )
        return AssistDecision(
            stage=request.stage,
            decision=self._respond(request),
            source="rules",
        )

    @staticmethod
    def _classify(request: AssistRequest) -> str:
        # A signature the sensors did not resolve reads as "indeterminate";
        # the honest answer is then the unresolved label, never a guess.
        if request.behavior == _INDETERMINATE:
            return "unknown"
        return _BEHAVIOR_TO_LABEL.get(request.behavior, "unknown")

    @staticmethod
    def _respond(request: AssistRequest) -> str:
        # The request validator guarantees a known classification; an unknown
        # one would only appear if the vocabulary changed under us, and the
        # conservative unresolved-track response is the safe fallback.
        return _LABEL_TO_RESPONSE.get(request.classification or "", "track")


_Post = Callable[..., Any]


class LlmAssistant:
    """Optional OpenAI-compatible engine; always falls back to the rules."""

    def __init__(
        self,
        base_url: str,
        model: str,
        api_key: str | None = None,
        timeout_s: float = 5.0,
        post: _Post | None = None,
        fallback: Assistant | None = None,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._model = model
        self._api_key = api_key
        self._timeout_s = timeout_s
        self._post = post or httpx.post
        self._fallback: Assistant = fallback or RuleAssistant()

    def _prompt(self, request: AssistRequest) -> str:
        if request.stage is AssistStage.classify:
            task = (
                "choose the best-supported classification label from: "
                "friendly, civilian, unknown, suspicious, hostile"
            )
            doctrine = (
                "steady-transit often friendly; slow-drift often civilian; "
                "erratic unclear identity; orbiting often suspicious; "
                "direct-approach often hostile; indeterminate signature unreadable"
            )
        else:
            task = (
                "choose the expected response from: monitor, track, report, hold"
            )
            doctrine = (
                "monitor known-friendly or civilian traffic; track an unresolved "
                "identity; report suspicious behavior; hold on a hostile classification"
            )
        return (
            "You are an airspace-training assistant supporting a simulated "
            "detection-and-classification exercise. Use ONLY the observable "
            "evidence provided; never invent facts. "
            f"Task: {task}. Training doctrine: {doctrine}. "
            'Reply with compact JSON of the form {"decision": string}.\n'
            f"observable_behavior={request.behavior}; cue_clear={str(request.cue_clear).lower()}; "
            f"flight_pattern={request.flight_pattern or 'none'}; "
            f"speed_class={request.speed_class or 'none'}; "
            f"observed_via={request.observed_via}; formation={str(request.swarm).lower()}; "
            f"current_assessment={request.classification or 'none'}."
        )

    def decide(self, request: AssistRequest) -> AssistDecision:
        headers = {"Content-Type": "application/json"}
        if self._api_key:
            headers["Authorization"] = f"Bearer {self._api_key}"
        try:
            response = self._post(
                f"{self._base_url}/chat/completions",
                json={
                    "model": self._model,
                    "temperature": 0,
                    "messages": [{"role": "user", "content": self._prompt(request)}],
                },
                headers=headers,
                timeout=self._timeout_s,
            )
            response.raise_for_status()
            content = response.json()["choices"][0]["message"]["content"]
            data = json.loads(content)
            decision_raw = data.get("decision")
            if not isinstance(decision_raw, str):
                raise ValueError("non-string decision")
            # AssistDecision validates the vocabulary; an out-of-vocabulary or
            # malformed answer raises here and the rules answer instead.
            return AssistDecision(
                stage=request.stage,
                decision=decision_raw.strip(),
                source="llm",
            )
        except Exception:  # noqa: BLE001 — intentional resilience boundary: any LLM/transport failure degrades to the rules
            return self._fallback.decide(request)


def get_assistant() -> Assistant:
    """LLM when configured, deterministic rules otherwise (offline default)."""
    if config.LLM_BASE_URL and config.LLM_MODEL:
        return LlmAssistant(
            base_url=config.LLM_BASE_URL,
            model=config.LLM_MODEL,
            api_key=config.LLM_API_KEY,
            timeout_s=config.LLM_TIMEOUT_S,
        )
    return RuleAssistant()
