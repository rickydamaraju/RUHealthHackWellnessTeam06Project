from app.model_adapter import _payload


def test_model_payload_excludes_zero_and_marks_missingness():
    meal = {"id": "meal", "eaten_at": "2026-10-10T12:00:00Z", "description": "lunch", "nutrition": {}, "foods": []}
    payload = _payload(
        meal,
        [{"timestamp": "2026-10-10T11:55:00Z", "glucose_mg_dl": 0}, {"timestamp": "2026-10-10T11:50:00Z", "glucose_mg_dl": 110}],
        [{"timestamp": "2026-10-10T11:00:00Z", "steps": 0, "heart_rate_bpm": 72}],
        health=[
            {"metric": "active_energy_kcal", "timestamp": "2026-10-10T10:00:00Z", "value": 0},
            {"metric": "steps", "timestamp": "2026-10-10T10:00:00Z", "value": 250},
            {"metric": "workout", "timestamp": "2026-10-10T09:00:00Z", "duration_seconds": 0},
        ],
    )
    assert payload["cgm_history"] == [{"timestamp": "2026-10-10T11:50:00Z", "glucose_mg_dl": 110}]
    assert payload["activity_history"] == [{"timestamp": "2026-10-10T11:00:00Z", "heart_rate_bpm": 72}]
    assert payload["apple_health_history"] == [{"metric": "steps", "timestamp": "2026-10-10T10:00:00Z", "value": 250}]
    assert payload["data_availability"]["missing_values_are_not_zero"] is True

