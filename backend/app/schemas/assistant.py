"""Pydantic models for the optional AI decision assistant.

The assistant maps trainee-visible evidence to one abstract decision at a
time (a classification label or an expected response). It never receives
ground truth, and its answer is advisory: the client still routes every
decision through the normal session gates and records it with assist
provenance, so it can never bypass a rule the operator could not bypass by
hand. Wording stays inside the existing abstract vocabulary; no model output
is passed through.

Source of truth: docs/api/openapi.yaml (AssistRequest, AssistDecision) and
docs/modules/ai_assisted_mode.md.
"""

from __future__ import annotations

from enum import Enum
from typing import Literal

from pydantic import BaseModel, model_validator

from app.schemas.scenario import ClassificationLabel, ExpectedResponse

CLASSIFY_VOCAB: frozenset[str] = frozenset(label.value for label in ClassificationLabel)
RESPOND_VOCAB: frozenset[str] = frozenset(response.value for response in ExpectedResponse)


class AssistStage(str, Enum):
    classify = "classify"
    respond = "respond"


class AssistRequest(BaseModel):
    """One decision request, built from public observable evidence only."""

    stage: AssistStage
    # Observable behavior signature, exactly what the trainee sees.
    behavior: str
    cue_clear: bool = False
    # Assigned motion and speed class: trainee-visible context, never an answer.
    flight_pattern: str | None = None
    speed_class: str | None = None
    # Which sensor currently holds the contact (visual resolves identity).
    observed_via: Literal["visual", "radar", "both"] = "visual"
    # Contact flies as part of a formation group.
    swarm: bool = False
    # The assessment already submitted for this contact, required to respond.
    # It is the assistant's own choice for the classify stage, quoted back for
    # the respond stage so the response doctrine follows the chosen label.
    classification: str | None = None

    @model_validator(mode="after")
    def _respond_needs_classification(self) -> "AssistRequest":
        if self.stage is AssistStage.respond:
            if self.classification not in CLASSIFY_VOCAB:
                raise ValueError("respond requires a known classification")
        return self


class AssistDecision(BaseModel):
    stage: AssistStage
    decision: str
    source: Literal["llm", "rules"]

    @model_validator(mode="after")
    def _decision_in_vocab(self) -> "AssistDecision":
        vocab = CLASSIFY_VOCAB if self.stage is AssistStage.classify else RESPOND_VOCAB
        if self.decision not in vocab:
            raise ValueError(f"decision not in vocabulary for {self.stage.value}")
        return self
