import pytest
from pydantic import ValidationError
from app.schemas import ModelOutput


def model_result(minutes=(30, 60, 90, 120)):
    return {
        "model_version": "team-model-1",
        "baseline_mg_dl": 98,
        "curve": [{"minutes": minute, "glucose_mg_dl": 98 + minute / 2} for minute in minutes],
        "feature_contributions": [{"feature": "carbs_g", "importance": 0.7}],
        "uncertainty": {"method": "bootstrap", "confidence": 0.8},
        "quality_flags": [],
    }


def test_accepts_complete_prediction_horizons():
    parsed = ModelOutput.model_validate(model_result())
    assert [point.minutes for point in parsed.curve] == [30, 60, 90, 120]


def test_rejects_missing_or_extra_prediction_horizons():
    with pytest.raises(ValidationError):
        ModelOutput.model_validate(model_result((30, 60, 90, 100)))
