"""Stable boundary between the product API and the team's person-specific model."""
import json
import os
from datetime import datetime, timezone
from uuid import uuid4
import boto3
from botocore.config import Config
from fastapi import HTTPException
from pydantic import ValidationError
from . import guardrails, storage
from .schemas import ModelOutput, timestamp


def _payload(meal: dict, readings: list[dict]) -> dict:
    return {
        "schema_version": "1.0",
        "meal": {
            "id": meal["id"],
            "eaten_at": meal["eaten_at"],
            "description": meal.get("description", ""),
            "nutrition": meal["nutrition"],
            "foods": meal["foods"],
        },
        "cgm_history": [
            {"timestamp": item["timestamp"], "glucose_mg_dl": item["glucose_mg_dl"]}
            for item in reversed(readings)
        ],
        # These stable keys let later versions add modalities without breaking the model contract.
        "heart_rate": [],
        "medications": [],
    }


def predict_and_store(owner: str, meal: dict):
    endpoint = os.environ.get("MODEL_ENDPOINT_NAME")
    if not endpoint:
        raise HTTPException(503, {"code": "model_not_connected", "message": "Your meal is saved. The prediction model has not been connected yet."})
    readings = storage.readings_before(owner, meal["eaten_at"], 2016)
    if not readings:
        raise HTTPException(422, {"code": "cgm_history_required", "message": "Upload CGM history before requesting a prediction."})
    try:
        response = boto3.client(
            "sagemaker-runtime",
            config=Config(connect_timeout=3, read_timeout=20, retries={"max_attempts": 1}),
        ).invoke_endpoint(
            EndpointName=endpoint,
            ContentType="application/json",
            Accept="application/json",
            Body=json.dumps(_payload(meal, readings)).encode(),
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
