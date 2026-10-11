from datetime import datetime, timezone

from app.main import predict_hypothetical_meal
from app.schemas import PredictionMealInput


def test_hypothetical_meal_predicts_without_persisting_meal(monkeypatch):
    captured = {}
    monkeypatch.setattr("app.main.catalog.meal_nutrition", lambda portions: (
        [{"food_id": "rice", "name": "Rice", "grams": 100, "nutrition": {}}],
        {"carbs_g": 40, "protein_g": 4, "fat_g": 1, "fiber_g": 1, "calories": 185},
    ))

    def predict(owner, meal, *, persist, allow_reference_fallback):
        captured.update(owner=owner, meal=meal, persist=persist, allow_reference_fallback=allow_reference_fallback)
        return {"id": "prediction"}

    monkeypatch.setattr("app.main.model_adapter.predict_and_store", predict)
    body = PredictionMealInput(
        description="rice", eaten_at=datetime(2026, 10, 11, 12, tzinfo=timezone.utc),
        foods=[{"food_id": "rice", "grams": 100}], entry_method="search",
    )
    assert predict_hypothetical_meal(body, owner="user-1") == {"id": "prediction"}
    assert captured["persist"] is False
    assert captured["allow_reference_fallback"] is True
    assert captured["meal"]["nutrition"]["carbs_g"] == 40
