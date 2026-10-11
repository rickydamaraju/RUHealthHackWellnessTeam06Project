import json
from decimal import Decimal
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient
from app import insights
from app.main import app, overall_insights


def test_insights_routes_require_authentication():
    client = TestClient(app)
    assert client.post('/insights', json={}).status_code == 401
    assert client.post('/insights/prediction', json={}).status_code == 401


def test_history_filters_meals_and_removes_private_fields():
    readings = [{'timestamp': f'2026-10-11T12:{m}:00Z', 'glucose_mg_dl': Decimal(v)}
                for m, v in [('00', '100'), ('05', '110'), ('40', '120'), ('45', '105')]]
    meals = [{'eaten_at': time, 'description': 'private text', 'id': 'private id',
              'nutrition': {'carbs_g': Decimal('42')}}
             for time in ['2026-10-10T12:00:00Z', '2026-10-11T12:10:00Z']]
    context = insights.history_context(readings, meals, True)
    assert len(context['meals']) == 1
    assert context['coverage']['largest_gap_minutes'] == 35
    assert context['meal_history_truncated'] is True
    assert 'private' not in json.dumps(context)
    assert context['meals'][0]['macros']['carbs_g'] == 42


def test_missing_meal_coverage_does_not_call_groq(monkeypatch):
    def records(owner, prefix, *args):
        assert owner == 'participant-1'
        if prefix == 'CGM#':
            return {'items': [{'timestamp': f'2026-10-11T12:{m}:00Z', 'glucose_mg_dl': 100}
                              for m in ['15', '10', '05', '00']]}
        return {'items': [{'eaten_at': '2026-10-10T12:00:00Z', 'nutrition': {}}]}
    monkeypatch.setattr('app.main.storage.list_records', records)
    provider = MagicMock()
    monkeypatch.setattr(insights, 'explain', provider)
    assert overall_insights(owner='participant-1')['status'] == 'insufficient_data'
    provider.assert_not_called()


def test_unconfigured_provider(monkeypatch):
    monkeypatch.delenv('GROQ_API_KEY', raising=False)
    monkeypatch.delenv('GROQ_SECRET_ARN', raising=False)
    assert insights.explain({})['status'] == 'unavailable'


@pytest.mark.parametrize('guardrail_status', ['passed', 'blocked', 'unavailable'])
def test_provider_keeps_reference_context_and_respects_guardrail(monkeypatch, guardrail_status):
    monkeypatch.setenv('GROQ_API_KEY', 'test-secret')
    explanation = {'summary': 'This shared-reference curve rises after the meal.',
                   'possible_factors': ['Carbohydrates may relate to the rise.'],
                   'limitations': 'This is not based on your own glucose measurements.'}
    captured = {}

    def provider(request, timeout):
        captured.update(json.loads(request.data))
        response = MagicMock()
        response.__enter__.return_value.read.return_value = json.dumps({
            'choices': [{'message': {'content': json.dumps(explanation)}}]}).encode()
        return response

    monkeypatch.setattr(insights, 'urlopen', provider)
    monkeypatch.setattr(insights.guardrails, 'screen_explanation',
                        lambda text: {'status': guardrail_status, 'text': text})
    result = insights.explain({'kind': 'predicted', 'cgm_context': 'shared_reference_fallback'})
    assert json.loads(captured['messages'][1]['content'])['cgm_context'] == 'shared_reference_fallback'
    if guardrail_status == 'passed':
        assert result['status'] == 'ready'
        assert result['limitations'] == explanation['limitations']
    else:
        assert result['status'] == guardrail_status
        assert 'summary' not in result


@pytest.mark.parametrize('content', ['not JSON', '{"summary": "incomplete"}'])
def test_malformed_provider_response_is_unavailable(monkeypatch, content):
    monkeypatch.setenv('GROQ_API_KEY', 'test-secret')
    response = MagicMock()
    response.__enter__.return_value.read.return_value = json.dumps({
        'choices': [{'message': {'content': content}}]}).encode()
    monkeypatch.setattr(insights, 'urlopen', lambda *args, **kwargs: response)
    assert insights.explain({})['status'] == 'unavailable'


def test_provider_error_does_not_expose_credentials(monkeypatch):
    monkeypatch.setenv('GROQ_API_KEY', 'private-secret')
    def fail(*args, **kwargs):
        raise RuntimeError('private-secret')
    monkeypatch.setattr(insights, 'urlopen', fail)
    result = insights.explain({})
    assert result['status'] == 'unavailable'
    assert 'private-secret' not in json.dumps(result)


def test_provider_limits_factors_and_requests_nonclinical_language(monkeypatch):
    monkeypatch.setenv('GROQ_API_KEY', 'test-secret')
    captured = {}
    explanation = {'summary': 'The predicted curve rises and then settles.',
                   'possible_factors': ['carbohydrate', 'protein', 'fat', 'fiber', 'invented factor'],
                   'limitations': 'The shared curve is not personal glucose data.'}

    def provider(request, timeout):
        captured.update(json.loads(request.data))
        response = MagicMock()
        response.__enter__.return_value.read.return_value = json.dumps({
            'choices': [{'message': {'content': json.dumps(explanation)}}]}).encode()
        return response

    monkeypatch.setattr(insights, 'urlopen', provider)
    monkeypatch.setattr(insights.guardrails, 'screen_explanation',
                        lambda text: {'status': 'passed', 'text': text})
    result = insights.explain({'kind': 'predicted'})
    assert result['status'] == 'ready'
    assert result['possible_factors'] == explanation['possible_factors'][:4]
    system_prompt = captured['messages'][0]['content']
    assert 'Never mention insulin' in system_prompt
    assert 'Do not invent activity' in system_prompt
    assert captured['response_format']['type'] == 'json_schema'
    assert captured['response_format']['json_schema']['strict'] is True
