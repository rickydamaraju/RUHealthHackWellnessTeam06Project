import pytest
from pydantic import ValidationError
from app.schemas import HealthSyncInput, ModelOutput, PhotoUploadInput, ProfileInput


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


def test_meal_photo_accepts_only_bounded_web_images():
    valid = PhotoUploadInput(filename="lunch.jpg", content_type="image/jpeg", size_bytes=1024)
    assert valid.content_type == "image/jpeg"
    with pytest.raises(ValidationError):
        PhotoUploadInput(filename="meal.svg", content_type="image/svg+xml", size_bytes=1024)
    with pytest.raises(ValidationError):
        PhotoUploadInput(filename="large.jpg", content_type="image/jpeg", size_bytes=16 * 1024 * 1024)
    assert PhotoUploadInput(filename="iphone.heic", content_type="image/heic", size_bytes=1024).content_type == "image/heic"


def test_profile_accepts_supported_units_and_statuses():
    profile = ProfileInput(first_name="Ada", last_name="Lovelace", age=30, height=66, height_unit="in", weight=140, weight_unit="lb", diabetes_status="unknown")
    assert profile.first_name == "Ada"
    with pytest.raises(ValidationError):
        ProfileInput(first_name="Ada", last_name="Lovelace", age=30, height=10, height_unit="cm", weight=140, weight_unit="lb", diabetes_status="unknown")


def test_health_sync_requires_timezone_and_supported_metrics():
    sync = HealthSyncInput(samples=[{
        "source_id": "apple-sample-1", "metric": "heart_rate_bpm", "value": 72,
        "start_at": "2026-10-10T08:00:00-04:00", "end_at": "2026-10-10T08:00:10-04:00",
    }])
    assert sync.samples[0].metric == "heart_rate_bpm"
    with pytest.raises(ValidationError):
        HealthSyncInput(samples=[{
            "source_id": "sample", "metric": "blood_pressure", "value": 120,
            "start_at": "2026-10-10T08:00:00", "end_at": "2026-10-10T08:00:10",
        }])
