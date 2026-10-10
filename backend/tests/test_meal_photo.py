import pytest
from fastapi import HTTPException

from app import meal_photo


def test_photo_analysis_requires_configured_model(monkeypatch):
    monkeypatch.delenv("BEDROCK_MODEL_ID", raising=False)
    with pytest.raises(HTTPException) as error:
        meal_photo.analyze(b"image", "image/jpeg")
    assert error.value.status_code == 503


def test_photo_analysis_rejects_unsupported_content_type(monkeypatch):
    monkeypatch.setenv("BEDROCK_MODEL_ID", "model")
    with pytest.raises(HTTPException) as error:
        meal_photo.analyze(b"image", "image/svg+xml")
    assert error.value.status_code == 422


def test_photo_analysis_maps_model_foods_to_catalog(monkeypatch):
    class Bedrock:
        def converse(self, **kwargs):
            assert kwargs["messages"][0]["content"][0]["image"]["format"] == "jpeg"
            return {"output": {"message": {"content": [{"text": '{"foods":[{"name":"rice","search_term":"white rice","grams":150,"confidence":0.9}]}'}]}}}

    food = {"id": "1", "name": "Rice, white", "per_100g": {}, "portions": []}
    monkeypatch.setenv("BEDROCK_MODEL_ID", "amazon.nova-lite-v1:0")
    monkeypatch.setattr(meal_photo.boto3, "client", lambda *args, **kwargs: Bedrock())
    monkeypatch.setattr(meal_photo.catalog, "search", lambda *args, **kwargs: [food])
    result = meal_photo.analyze(b"image", "image/jpeg")
    assert result["items"][0]["grams"] == 150
    assert result["items"][0]["matches"][0]["id"] == "1"
