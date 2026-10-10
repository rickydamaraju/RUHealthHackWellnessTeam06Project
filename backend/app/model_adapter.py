"""Stable boundary between the product API and the team's person-specific model."""
import json
import math
import os
from datetime import datetime, timedelta, timezone
from uuid import uuid4
import boto3
from botocore.config import Config
from fastapi import HTTPException
from pydantic import ValidationError
from . import guardrails, storage
from .schemas import ModelOutput, timestamp


def _payload(meal: dict, readings: list[dict], activity: list[dict] | None = None, profile: dict | None = None, health: list[dict] | None = None) -> dict:
    activity = activity or []
    health = health or []
    # Missing observations stay missing. In particular, zero-valued HealthKit
    # aggregate buckets are not evidence that the participant did no activity.
    valid_readings = [item for item in readings if _positive(item.get("glucose_mg_dl"))]
    valid_activity = [
        {key: value for key, value in item.items() if key == "timestamp" or (key in {"steps", "active_energy_kcal", "heart_rate_bpm"} and _positive(value))}
        for item in activity
    ]
    valid_activity = [item for item in valid_activity if len(item) > 1]
    valid_health = [item for item in health if _valid_health_record(item)]
    return {
        "schema_version": "1.0",
        "participant": {key: profile[key] for key in ("age", "height_cm", "weight_kg", "diabetes_status") if profile and key in profile},
        "meal": {
            "id": meal["id"],
            "eaten_at": meal["eaten_at"],
            "description": meal.get("description", ""),
            "nutrition": meal["nutrition"],
            "foods": meal["foods"],
        },
        "cgm_history": [
            {"timestamp": item["timestamp"], "glucose_mg_dl": item["glucose_mg_dl"]}
            for item in reversed(valid_readings)
        ],
        "activity_history": [
            {key: item[key] for key in ("timestamp", "steps", "active_energy_kcal", "heart_rate_bpm") if key in item}
            for item in reversed(valid_activity)
        ],
        "heart_rate": [
            {"timestamp": item["timestamp"], "heart_rate_bpm": item["heart_rate_bpm"]}
            for item in reversed(valid_activity) if "heart_rate_bpm" in item
        ] + [
            {"timestamp": item["timestamp"], "heart_rate_bpm": item["value"]}
            for item in reversed(valid_health) if item.get("metric") == "heart_rate_bpm"
        ],
        "apple_health_history": [
            {key: item[key] for key in ("metric", "timestamp", "end_timestamp", "value", "duration_seconds", "energy_kcal", "activity_type") if key in item}
            for item in reversed(valid_health)
        ],
        "data_availability": {
            "cgm_observations": len(valid_readings),
            "activity_observations": len(valid_activity),
            "apple_health_observations": len(valid_health),
            "missing_values_are_not_zero": True,
        },
        "medications": [],
    }


def _positive(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value > 0


def _valid_health_record(item: dict) -> bool:
    if item.get("metric") == "workout":
        return _positive(item.get("duration_seconds"))
    return _positive(item.get("value"))


def predict_and_store(owner: str, meal: dict):
    endpoint = os.environ.get("MODEL_ENDPOINT_NAME")
    if not endpoint:
        raise HTTPException(503, {"code": "model_not_connected", "message": "Your meal is saved. The prediction model has not been connected yet."})
    readings = storage.readings_before(owner, meal["eaten_at"], 2016)
    activity = storage.activity_before(owner, meal["eaten_at"], 2016)
    cutoff = datetime.fromisoformat(meal["eaten_at"].replace("Z", "+00:00"))
    health_start = timestamp(cutoff - timedelta(days=7))
    health = storage.health_before(owner, health_start, meal["eaten_at"], 10000)
    profile = storage.get_record(owner, "PROFILE")
    if not any(_positive(item.get("glucose_mg_dl")) for item in readings):
        raise HTTPException(422, {"code": "cgm_history_required", "message": "Upload CGM history before requesting a prediction."})
    try:
        response = boto3.client(
            "sagemaker-runtime",
            config=Config(connect_timeout=3, read_timeout=20, retries={"max_attempts": 1}),
        ).invoke_endpoint(
            EndpointName=endpoint,
            ContentType="application/json",
            Accept="application/json",
            Body=json.dumps(_payload(meal, readings, activity, profile, health)).encode(),
        )
        result = ModelOutput.model_validate_json(response["Body"].read())
    except (ValidationError, ValueError, KeyError, json.JSONDecodeError):
        raise HTTPException(502, "The model returned an invalid prediction. Check the model contract.") from None
    except Exception:
        # Participant inputs and vendor details must not leak into the response or logs.
        raise HTTPException(503, "The prediction service is temporarily unavailable.") from None

    peak_point = max(result.curve, key=lambda point: point.glucose_mg_dl)
    excursion = peak_point.glucose_mg_dl - result.baseline_mg_dl
    explanation = (
        f"This wellness estimate has a peak of {peak_point.glucose_mg_dl:.0f} mg/dL "
        f"about {peak_point.minutes} minutes after the meal, an excursion of {excursion:.0f} mg/dL "
        "from the model baseline. It is not a diagnosis or medication recommendation."
    )
    screened = guardrails.screen_explanation(explanation)
    prediction_id = str(uuid4())
    created_at = timestamp(datetime.now(timezone.utc))
    saved = {
        "id": prediction_id,
        "meal_id": meal["id"],
        "created_at": created_at,
        "model_version": result.model_version,
        "baseline_mg_dl": result.baseline_mg_dl,
        "curve": [point.model_dump() for point in result.curve],
        "peak_mg_dl": peak_point.glucose_mg_dl,
        "time_to_peak_minutes": peak_point.minutes,
        "excursion_mg_dl": round(excursion, 3),
        "feature_contributions": result.feature_contributions,
        "uncertainty": result.uncertainty,
        "quality_flags": result.quality_flags,
        "explanation": screened["text"],
        "guardrail_status": screened["status"],
    }
    storage.save_record(owner, f"PREDICTION#{prediction_id}", saved, create_only=True)
    return storage.public_record(saved)
