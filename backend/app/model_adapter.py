"""Stable boundary between the product API and the hosted SageMaker model."""
import csv
import io
import json
import math
import os
from datetime import datetime, timedelta, timezone
from functools import lru_cache
from uuid import uuid4

import boto3
from botocore.config import Config
from fastapi import HTTPException
from pydantic import ValidationError

from . import guardrails, storage
from .schemas import ModelOutput, timestamp


def _positive(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value > 0


def _when(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)


def _real_cgm(readings: list[dict], start: datetime, cutoff: datetime) -> list[dict]:
    """Use participant uploads only; Dexcom sandbox rows never reach the model."""
    selected = []
    for item in readings:
        try:
            observed_at = _when(item["timestamp"])
            glucose = float(item.get("glucose_mg_dl", 0))
        except (KeyError, TypeError, ValueError):
            continue
        uploaded = bool(item.get("import_id")) or item.get("source") in {"cgm_upload", "user_upload"}
        if uploaded and item.get("source") != "dexcom" and start <= observed_at < cutoff and 40 <= glucose <= 400:
            selected.append(item)
    return sorted(selected, key=lambda item: item["timestamp"])


def _uploaded_cgm(readings: list[dict]) -> list[dict]:
    selected = []
    for item in readings:
        try:
            _when(item["timestamp"])
            glucose = float(item.get("glucose_mg_dl", 0))
        except (KeyError, TypeError, ValueError):
            continue
        uploaded = bool(item.get("import_id")) or item.get("source") in {"cgm_upload", "user_upload"}
        if uploaded and item.get("source") != "dexcom" and 40 <= glucose <= 400:
            selected.append({**item, "glucose_mg_dl": glucose})
    return sorted(selected, key=lambda item: item["timestamp"])


def _reanchor_cgm(readings: list[dict], cutoff: datetime) -> list[dict]:
    """Preserve a participant's observed pattern while aligning it to a planned meal."""
    latest = max(_when(item["timestamp"]) for item in readings)
    earliest = latest - timedelta(days=7) + timedelta(minutes=1)
    shift = cutoff - timedelta(minutes=1) - latest
    return [
        {**item, "timestamp": timestamp(_when(item["timestamp"]) + shift)}
        for item in readings if _when(item["timestamp"]) >= earliest
    ]


@lru_cache
def _shared_reference_rows() -> tuple[tuple[int, float], ...]:
    bucket = os.environ.get("MODELS_BUCKET")
    key = os.environ.get("FALLBACK_CGM_KEY")
    if not bucket or not key:
        raise HTTPException(503, "The shared CGM reference is not configured.")
    try:
        body = boto3.client("s3").get_object(Bucket=bucket, Key=key)["Body"].read().decode("utf-8")
        rows = []
        for item in csv.DictReader(io.StringIO(body)):
            offset, glucose = int(item["offset_minutes"]), float(item["glucose_mg_dl"])
            if offset >= 0 and 40 <= glucose <= 400 and math.isfinite(glucose):
                rows.append((offset, glucose))
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(503, "The shared CGM reference could not be loaded.") from None
    rows = sorted(set(rows))
    if len(rows) < 3 or rows[-1][0] - rows[0][0] < 10:
        raise HTTPException(503, "The shared CGM reference is incomplete.")
    return tuple(rows)


def _reference_cgm(cutoff: datetime) -> list[dict]:
    rows = _shared_reference_rows()
    anchor = cutoff - timedelta(minutes=rows[-1][0] + 1)
    return [
        {"timestamp": timestamp(anchor + timedelta(minutes=offset)), "glucose_mg_dl": glucose, "source": "shared_reference"}
        for offset, glucose in rows
    ]


def _valid_health_record(item: dict) -> bool:
    if item.get("metric") == "workout":
        return _positive(item.get("duration_seconds"))
    return _positive(item.get("value"))


def _history_csv(readings: list[dict], health: list[dict], prior_meals: list[dict], profile: dict | None) -> str:
    """Adapt DynamoDB records to the exact CSV contract of glucose44."""
    columns = ["Timestamp", "glucose", "HR", "METs", "Calories (Activity)", "Meal Type", "Carbs", "Protein", "Fat", "Fiber", "Calories"]
    rows: dict[str, dict] = {}

    def row(at: str) -> dict:
        return rows.setdefault(at, {name: "" for name in columns} | {"Timestamp": at})

    for item in readings:
        row(item["timestamp"])["glucose"] = float(item["glucose_mg_dl"])

    weight_kg = float(profile.get("weight_kg", 0)) if profile else 0
    for item in health:
        if not _valid_health_record(item):
            continue
        target = row(item["timestamp"])
        metric = item.get("metric")
        if metric == "heart_rate_bpm":
            target["HR"] = float(item["value"])
        elif metric == "active_energy_kcal":
            target["Calories (Activity)"] = float(item["value"])
            duration = (_when(item.get("end_timestamp", item["timestamp"])) - _when(item["timestamp"])).total_seconds() / 3600
            if weight_kg > 0 and duration > 0:
                target["METs"] = round(min(18.0, max(1.0, 1.0 + float(item["value"]) / (weight_kg * duration))), 3)
        elif metric == "workout" and _positive(item.get("energy_kcal")) and weight_kg > 0:
            hours = float(item["duration_seconds"]) / 3600
            target["Calories (Activity)"] = float(item["energy_kcal"])
            target["METs"] = round(min(18.0, max(1.0, 1.0 + float(item["energy_kcal"]) / (weight_kg * hours))), 3)

    for meal in prior_meals:
        target = row(meal["eaten_at"])
        nutrition = meal.get("nutrition", {})
        target.update({
            "Meal Type": meal.get("description") or "Saved meal",
            "Carbs": nutrition.get("carbs_g", ""), "Protein": nutrition.get("protein_g", ""),
            "Fat": nutrition.get("fat_g", ""), "Fiber": nutrition.get("fiber_g", ""),
            "Calories": nutrition.get("calories", ""),
        })

    output = io.StringIO()
    writer = csv.DictWriter(output, fieldnames=columns, lineterminator="\n")
    writer.writeheader()
    writer.writerows(rows[key] for key in sorted(rows))
    return output.getvalue()


def _payload(meal: dict, readings: list[dict], activity: list[dict] | None = None, profile: dict | None = None,
             health: list[dict] | None = None, prior_meals: list[dict] | None = None) -> dict:
    """Create the deployed endpoint request. Activity is retained for API compatibility."""
    del activity
    nutrition = meal["nutrition"]
    return {
        "history_csv": _history_csv(readings, health or [], prior_meals or [], profile),
        "meal_time": meal["eaten_at"],
        "macros": {
            "carbs": nutrition["carbs_g"], "protein": nutrition["protein_g"],
            "fat": nutrition["fat_g"], "fiber": nutrition["fiber_g"],
        },
        "guard_minutes": 0,
        "utc_offset_minutes": 0,
    }


def _ensure_recent_cgm(readings: list[dict], meal_time: datetime):
    recent = [item for item in readings if timedelta(0) < meal_time - _when(item["timestamp"]) <= timedelta(minutes=15)]
    if len(recent) < 3:
        raise HTTPException(422, {"code": "real_cgm_history_required", "message": "This model needs at least three real uploaded glucose readings during the 15 minutes before the meal. Dexcom sandbox data is excluded."})
    times = sorted(_when(item["timestamp"]) for item in recent)
    if times[-1] < meal_time - timedelta(minutes=5) or times[-1] - times[0] < timedelta(minutes=10):
        raise HTTPException(422, {"code": "real_cgm_history_required", "message": "The uploaded glucose history must reach within five minutes of the meal and span at least ten pre-meal minutes. Dexcom sandbox data is excluded."})


def _prediction_cgm(readings: list[dict], start: datetime, cutoff: datetime, allow_reference_fallback: bool):
    recent = _real_cgm(readings, start, cutoff)
    try:
        _ensure_recent_cgm(recent, cutoff)
        return recent, "participant_upload"
    except HTTPException:
        if not allow_reference_fallback:
            raise
    uploaded = _uploaded_cgm(readings)
    if uploaded:
        aligned = _reanchor_cgm(uploaded, cutoff)
        try:
            _ensure_recent_cgm(aligned, cutoff)
            return aligned, "participant_upload_reanchored"
        except HTTPException:
            pass
    reference = _reference_cgm(cutoff)
    _ensure_recent_cgm(reference, cutoff)
    return reference, "shared_reference_fallback"


def predict_and_store(owner: str, meal: dict, *, persist: bool = True, allow_reference_fallback: bool = False):
    endpoint = os.environ.get("MODEL_ENDPOINT_NAME")
    if not endpoint:
        raise HTTPException(503, {"code": "model_not_connected", "message": "Your meal is saved. The prediction model has not been connected yet."})
    cutoff = _when(meal["eaten_at"])
    start = cutoff - timedelta(days=7)
    readings, cgm_context = _prediction_cgm(
        storage.readings_before(owner, meal["eaten_at"], 10000), start, cutoff, allow_reference_fallback,
    )
    health = storage.health_before(owner, timestamp(start), meal["eaten_at"], 10000)
    profile = storage.get_record(owner, "PROFILE")
    prior_meals = [item for item in storage.meals_before(owner, timestamp(start), meal["eaten_at"], 200) if item.get("id") != meal["id"]]
    payload = _payload(meal, readings, profile=profile, health=health, prior_meals=prior_meals)
    try:
        response = boto3.client("sagemaker-runtime", config=Config(connect_timeout=3, read_timeout=30, retries={"max_attempts": 1})).invoke_endpoint(
            EndpointName=endpoint, ContentType="application/json", Accept="application/json", Body=json.dumps(payload).encode(),
        )
        result = ModelOutput.model_validate_json(response["Body"].read())
    except (ValidationError, ValueError, KeyError, json.JSONDecodeError):
        raise HTTPException(502, "The model returned an invalid prediction. Check the model contract.") from None
    except Exception:
        raise HTTPException(503, "The prediction service is temporarily unavailable.") from None

    peak_point = max(result.curve, key=lambda point: point.glucose_mg_dl)
    excursion = peak_point.glucose_mg_dl - result.baseline_mg_dl
    context_text = {
        "participant_upload": "real uploaded glucose history",
        "participant_upload_reanchored": "the participant's uploaded glucose pattern aligned to the planned meal time",
        "shared_reference_fallback": "a shared held-out CGM reference because this account has no usable uploaded CGM",
    }[cgm_context]
    explanation = (
        f"This wellness estimate predicts a peak near {peak_point.glucose_mg_dl:.0f} mg/dL about {peak_point.minutes} minutes after the meal, "
        f"an excursion of about {excursion:.0f} mg/dL from the model baseline. It uses the saved meal nutrition, {context_text}, "
        "and supported Apple Health context. It is not a diagnosis or medication recommendation."
    )
    screened = guardrails.screen_explanation(explanation)
    health_counts: dict[str, int] = {}
    for item in health:
        if _valid_health_record(item):
            metric = item.get("metric", "unknown")
            health_counts[metric] = health_counts.get(metric, 0) + 1
    prediction_id = str(uuid4())
    quality_flags = list(result.quality_flags)
    if cgm_context == "shared_reference_fallback":
        quality_flags.append("Shared held-out CGM reference used because this account has no usable uploaded CGM; the curve is not based on this user's glucose measurements.")
    elif cgm_context == "participant_upload_reanchored":
        quality_flags.append("The participant's latest uploaded CGM pattern was aligned to the planned meal time.")
    saved = {
        "id": prediction_id, "meal_id": meal["id"], "created_at": timestamp(datetime.now(timezone.utc)),
        "model_version": result.model_version, "baseline_mg_dl": result.baseline_mg_dl,
        "curve": [point.model_dump() for point in result.curve],
        "peak_mg_dl": peak_point.glucose_mg_dl, "time_to_peak_minutes": peak_point.minutes,
        "excursion_mg_dl": round(excursion, 3), "feature_contributions": result.feature_contributions,
        "uncertainty": result.uncertainty, "quality_flags": quality_flags,
        "explanation": screened["text"], "guardrail_status": screened["status"],
        "input_summary": {
            "meal_macros": {"carbs_g": meal["nutrition"]["carbs_g"], "protein_g": meal["nutrition"]["protein_g"], "fat_g": meal["nutrition"]["fat_g"], "fiber_g": meal["nutrition"]["fiber_g"]},
            "real_cgm_observations": len(readings) if cgm_context != "shared_reference_fallback" else 0,
            "reference_cgm_observations": len(readings) if cgm_context == "shared_reference_fallback" else 0,
            "cgm_context": cgm_context, "reference_cgm_fallback_used": cgm_context == "shared_reference_fallback",
            "apple_health_observations": health_counts,
            "prior_meals": len(prior_meals), "dexcom_sandbox_excluded": True,
        },
    }
    if persist:
        storage.save_record(owner, f"PREDICTION#{prediction_id}", saved, create_only=True)
    return storage.public_record(saved)
