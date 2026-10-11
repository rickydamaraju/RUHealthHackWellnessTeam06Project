import csv
import io
from datetime import datetime, timezone

from app.model_adapter import _payload, _real_cgm


def meal():
    return {
        "id": "meal", "eaten_at": "2026-10-10T12:00:00Z", "description": "lunch",
        "nutrition": {"carbs_g": 42, "protein_g": 18, "fat_g": 12, "fiber_g": 6, "calories": 348},
        "foods": [],
    }


def test_prediction_excludes_dexcom_sandbox_and_invalid_glucose():
    start = datetime(2026, 10, 3, 12, tzinfo=timezone.utc)
    cutoff = datetime(2026, 10, 10, 12, tzinfo=timezone.utc)
    selected = _real_cgm([
        {"timestamp": "2026-10-10T11:45:00Z", "glucose_mg_dl": 110, "source": "dexcom"},
        {"timestamp": "2026-10-10T11:50:00Z", "glucose_mg_dl": 0, "import_id": "upload"},
        {"timestamp": "2026-10-10T11:55:00Z", "glucose_mg_dl": 112, "import_id": "upload"},
    ], start, cutoff)
    assert selected == [{"timestamp": "2026-10-10T11:55:00Z", "glucose_mg_dl": 112, "import_id": "upload"}]


def test_model_payload_matches_endpoint_and_keeps_only_supported_health_values():
    payload = _payload(
        meal(),
        [{"timestamp": "2026-10-10T11:55:00Z", "glucose_mg_dl": 110, "import_id": "upload"}],
        profile={"weight_kg": 70},
        health=[
            {"metric": "heart_rate_bpm", "timestamp": "2026-10-10T11:50:00Z", "end_timestamp": "2026-10-10T11:50:30Z", "value": 72},
            {"metric": "active_energy_kcal", "timestamp": "2026-10-10T11:00:00Z", "end_timestamp": "2026-10-10T11:30:00Z", "value": 35},
            {"metric": "steps", "timestamp": "2026-10-10T10:00:00Z", "end_timestamp": "2026-10-10T10:10:00Z", "value": 0},
        ],
        prior_meals=[{
            "id": "earlier", "eaten_at": "2026-10-09T12:00:00Z", "description": "breakfast",
            "nutrition": {"carbs_g": 30, "protein_g": 10, "fat_g": 5, "fiber_g": 3, "calories": 205},
        }],
    )
    assert payload["macros"] == {"carbs": 42, "protein": 18, "fat": 12, "fiber": 6}
    rows = list(csv.DictReader(io.StringIO(payload["history_csv"])))
    assert next(row for row in rows if row["Timestamp"] == "2026-10-10T11:55:00Z")["glucose"] == "110.0"
    assert next(row for row in rows if row["Timestamp"] == "2026-10-10T11:50:00Z")["HR"] == "72.0"
    assert next(row for row in rows if row["Timestamp"] == "2026-10-09T12:00:00Z")["Carbs"] == "30"
    assert not any(row["Timestamp"] == "2026-10-10T10:00:00Z" for row in rows)
