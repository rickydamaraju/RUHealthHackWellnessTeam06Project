import json
from unittest.mock import MagicMock

import pytest
from fastapi import HTTPException

from app import meal_text


def _response(content):
    response = MagicMock()
    response.__enter__.return_value.read.return_value = json.dumps({
        "choices": [{"message": {"content": json.dumps(content)}}],
    }).encode()
    return response


def test_groq_estimates_portions_and_maps_to_usda(monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", "test-secret")
    captured = {}
    extraction = {"foods": [{
        "name": "two fried eggs", "search_term": "fried egg", "grams": 92,
        "portion_description": "2 large eggs", "confidence": 0.91,
    }]}

    def provider(request, timeout):
        captured.update(json.loads(request.data))
        return _response(extraction)

    food = {"id": "egg", "name": "Egg, fried", "per_100g": {"calories": 196}, "portions": []}
    monkeypatch.setattr(meal_text, "urlopen", provider)
    monkeypatch.setattr(meal_text, "search", lambda query, limit: [food])
    result = meal_text.interpret("two fried eggs")

    assert result["source"] == "groq_usda"
    assert result["items"][0]["grams"] == 92
    assert result["items"][0]["portion_description"] == "2 large eggs"
    assert result["items"][0]["matches"][0]["id"] == "egg"
    assert captured["response_format"]["json_schema"]["strict"] is True
    assert "typical single-serving estimate" in captured["messages"][0]["content"]


def test_groq_uses_name_as_catalog_fallback(monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", "test-secret")
    extraction = {"foods": [{
        "name": "oatmeal", "search_term": "hot oats", "grams": 240,
        "portion_description": "1 bowl", "confidence": 0.7,
    }]}
    monkeypatch.setattr(meal_text, "urlopen", lambda *args, **kwargs: _response(extraction))
    food = {"id": "oats", "name": "Oatmeal, cooked", "per_100g": {}, "portions": []}
    calls = []
    monkeypatch.setattr(meal_text, "search", lambda query, limit: calls.append(query) or ([] if query == "hot oats" else [food]))

    result = meal_text.interpret("a bowl of oatmeal")
    assert calls == ["hot oats", "oatmeal"]
    assert result["items"][0]["matches"][0]["id"] == "oats"


def test_unconfigured_groq_is_safe(monkeypatch):
    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    monkeypatch.delenv("GROQ_SECRET_ARN", raising=False)
    with pytest.raises(HTTPException) as error:
        meal_text.interpret("toast")
    assert error.value.status_code == 503


def test_provider_error_does_not_expose_credentials(monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", "private-secret")
    monkeypatch.setattr(meal_text, "urlopen", lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("private-secret")))
    with pytest.raises(HTTPException) as error:
        meal_text.interpret("toast")
    assert "private-secret" not in str(error.value.detail)
