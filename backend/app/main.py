from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.aar import router as aar_router
from app.api.assistant import router as assistant_router
from app.api.scenarios import router as scenarios_router
from app.api.sessions import router as sessions_router
from app.api.training import router as training_router
from app.db.database import init_db
from app.services.anti_repetition import RecentConfigTracker


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    yield


app = FastAPI(title="Aeroguard API", version="1.0.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.state.recent_configs = RecentConfigTracker()

app.include_router(scenarios_router, prefix="/api/v1")
app.include_router(sessions_router, prefix="/api/v1")
app.include_router(aar_router, prefix="/api/v1")
app.include_router(training_router, prefix="/api/v1")
app.include_router(assistant_router, prefix="/api/v1")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}
