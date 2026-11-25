"""
Internal HTTP service for the New Assessment Center Model.

The NestJS API is the only public backend; this service is called internally. It loads the raw TESDA data once
(~25 s, ~1.2 GB), then predicts new centers in milliseconds.

    NEW_CENTER_DATA_DIR=/data NEW_CENTER_LAST_MONTH=2026-10 uvicorn service:app --host 0.0.0.0 --port 8010

Never expose this port publicly: the raw data contains learner IDs.
"""
import hashlib
import os
import threading
import time
from typing import Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from new_center_inputs import InputBuilder
from predict_new_center import load_models, predict_center

HERE = os.path.dirname(os.path.abspath(__file__))
MODEL_DIR = os.environ.get("NEW_CENTER_MODEL_DIR", os.path.join(HERE, "models"))
DATA_DIR = os.environ.get("NEW_CENTER_DATA_DIR", "/data")
LAST_MONTH = os.environ.get("NEW_CENTER_LAST_MONTH", "").strip()

_lock = threading.Lock()
_state: dict = {}


class CenterIn(BaseModel):
    name: Optional[str] = None
    province_id: int
    city_id: Optional[int] = None
    qual_ids: list[int] = Field(min_length=1)
    accreditation_month: str
    school_ids: list[int] = Field(default_factory=list)
    center_type: Optional[int] = None
    center_class: Optional[int] = None
    latitude: Optional[float] = None
    longitude: Optional[float] = None


class PredictIn(BaseModel):
    centers: list[CenterIn] = Field(min_length=1)


def model_version() -> str:
    digest = hashlib.sha256()
    cfg = os.path.join(MODEL_DIR, "config.json")
    with open(cfg, "rb") as fh:
        digest.update(fh.read())
    import json
    with open(cfg, encoding="utf-8") as fh:
        config = json.load(fh)
    for section in ("count_model", "chance_model"):
        with open(os.path.join(MODEL_DIR, config[section]["file"]), "rb") as fh:
            digest.update(fh.read())
    return "new-center-" + digest.hexdigest()[:12]


def load(last_month: str, data_dir: str) -> None:
    if not last_month:
        raise RuntimeError("NEW_CENTER_LAST_MONTH is required (YYYY-MM)")
    started = time.time()
    cfg, count, chance = load_models(MODEL_DIR)
    builder = InputBuilder(data_dir, last_month)
    with _lock:
        _state.update(
            {
                "cfg": cfg,
                "count": count,
                "chance": chance,
                "builder": builder,
                "last_month": last_month,
                "data_dir": data_dir,
                "model_version": model_version(),
                "loaded_at": int(time.time()),
                "load_seconds": round(time.time() - started, 1),
            }
        )


def add_month(label: str, months: int) -> str:
    year, month = [int(v) for v in label.split("-")]
    total = year * 12 + (month - 1) + months
    return f"{total // 12:04d}-{total % 12 + 1:02d}"


def latest_allowed_month(last_month: str) -> str:
    return add_month(last_month, 1)


app = FastAPI(title="New Assessment Center Model", version="1.0")


@app.on_event("startup")
def startup() -> None:
    load(LAST_MONTH, DATA_DIR)


@app.get("/health")
def health() -> dict:
    if not _state:
        raise HTTPException(status_code=503, detail="model not loaded")
    return {
        "status": "ok",
        "lastMonth": _state["last_month"],
        "modelVersion": _state["model_version"],
        "loadedAt": _state["loaded_at"],
    }


@app.get("/meta")
def meta() -> dict:
    if not _state:
        raise HTTPException(status_code=503, detail="model not loaded")
    cfg = _state["cfg"]
    return {
        "lastMonth": _state["last_month"],
        "latestAccreditationMonth": latest_allowed_month(_state["last_month"]),
        "modelVersion": _state["model_version"],
        "sampleRate": cfg.get("sample_rate"),
        "trainedOn": cfg.get("trained_on"),
        "testAccuracy": cfg.get("test_accuracy"),
        "versions": cfg.get("versions"),
        "loadSeconds": _state["load_seconds"],
    }


@app.post("/predict")
def predict(body: PredictIn) -> dict:
    if not _state:
        raise HTTPException(status_code=503, detail="model not loaded")
    last_month = _state["last_month"]
    latest = latest_allowed_month(last_month)
    for center in body.centers:
        if center.accreditation_month > latest:
            raise HTTPException(
                status_code=400,
                detail=f"accreditation_month {center.accreditation_month} is after the latest allowed {latest}",
            )
    predictions = []
    for center in body.centers:
        try:
            predictions.append(
                predict_center(_state["builder"], center.model_dump(), _state["cfg"], _state["count"], _state["chance"])
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {
        "lastMonth": last_month,
        "modelVersion": _state["model_version"],
        "predictions": predictions,
    }


@app.post("/reload")
def reload_model(body: dict) -> dict:
    last_month = str(body.get("lastMonth") or "").strip()
    data_dir = str(body.get("dataDir") or DATA_DIR)
    load(last_month, data_dir)
    return {"status": "ok", "lastMonth": last_month, "modelVersion": _state["model_version"]}
