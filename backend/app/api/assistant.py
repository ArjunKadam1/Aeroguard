"""AI decision assistant route.

    POST /api/v1/assist/decide

Thin by design: the request carries public observable evidence only and the
service answers with one abstract decision. No database access, no session
state, no ground truth.
"""

from __future__ import annotations

from fastapi import APIRouter

from app.schemas.assistant import AssistDecision, AssistRequest
from app.services.assistant import get_assistant

router = APIRouter(tags=["assistant"])


@router.post("/assist/decide", response_model=AssistDecision)
def decide(body: AssistRequest) -> AssistDecision:
    return get_assistant().decide(body)
