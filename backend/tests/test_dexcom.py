from datetime import datetime, timezone
import pytest

from app.dexcom import _dexcom_datetime, _dexcom_time


def test_dexcom_time_preserves_observation_as_utc():
    assert _dexcom_time("2026-10-10T08:00:00-04:00") == "2026-10-10T12:00:00Z"
    assert _dexcom_time("2026-10-10T12:00:00") == "2026-10-10T12:00:00Z"
    assert _dexcom_time("not-a-time") is None


def test_dexcom_datetime_normalizes_offsets_for_range_queries():
    assert _dexcom_datetime("2025-05-01T01:10:08-07:00") == datetime(2025, 5, 1, 8, 10, 8, tzinfo=timezone.utc)
    assert _dexcom_datetime(None) is None


def test_scheduled_worker_continues_after_one_user_fails(monkeypatch):
    from fastapi import HTTPException
    from app import dexcom_worker

    monkeypatch.setattr(dexcom_worker.storage, "dexcom_connection_owners", lambda: iter(["one", "two"]))

    def sync(owner):
        if owner == "one":
            raise HTTPException(502, "temporary")
        return {"accepted": 2}

    monkeypatch.setattr(dexcom_worker.dexcom, "sync", sync)
    with pytest.raises(RuntimeError, match="failed for 1 of 2"):
        dexcom_worker.handler({}, None)
