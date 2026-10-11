import pytest
from fastapi import HTTPException
from io import BytesIO
from PIL import Image

from app import meal_photo


@pytest.mark.parametrize(("image_format", "content_type"), [
    ("PNG", "image/png"), ("WEBP", "image/webp"), ("GIF", "image/gif"),
    ("BMP", "image/bmp"), ("TIFF", "image/tiff"), ("HEIF", "image/heic"),
    ("AVIF", "image/avif"),
])
def test_common_photo_formats_are_normalized_to_jpeg(image_format, content_type):
    source = BytesIO()
    Image.new("RGB", (32, 24), "green").save(source, format=image_format)
    converted, bedrock_format = meal_photo._normalize_image(source.getvalue(), content_type)
    assert bedrock_format == "jpeg"
    assert converted.startswith(b"\xff\xd8\xff")


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
    monkeypatch.setattr(meal_photo, "_normalize_image", lambda *args: (b"image", "jpeg"))
    monkeypatch.setattr(meal_photo.boto3, "client", lambda *args, **kwargs: Bedrock())
    monkeypatch.setattr(meal_photo.catalog, "search", lambda *args, **kwargs: [food])
    result = meal_photo.analyze(b"image", "image/jpeg")
    assert result["items"][0]["grams"] == 150
    assert result["items"][0]["matches"][0]["id"] == "1"


def test_photo_analysis_replaces_generic_food_name_with_catalog_name(monkeypatch):
    class Bedrock:
        def converse(self, **kwargs):
            return {"output": {"message": {"content": [{"text": '{"foods":[{"name":"visible food","search_term":"pretzels","grams":60,"confidence":0.8}]}'}]}}}

    food = {"id": "2", "name": "Pretzels, hard, salted", "per_100g": {}, "portions": []}
    monkeypatch.setenv("BEDROCK_MODEL_ID", "amazon.nova-lite-v1:0")
    monkeypatch.setattr(meal_photo.boto3, "client", lambda *args, **kwargs: Bedrock())
    monkeypatch.setattr(meal_photo.catalog, "search", lambda *args, **kwargs: [food])
    result = meal_photo.analyze_jpeg(b"image")
    assert result["items"][0]["name"] == "Pretzels, hard, salted"
