from app.dexcom import _dexcom_time


def test_dexcom_time_preserves_observation_as_utc():
    assert _dexcom_time("2026-10-10T08:00:00-04:00") == "2026-10-10T12:00:00Z"
    assert _dexcom_time("2026-10-10T12:00:00") == "2026-10-10T12:00:00Z"
    assert _dexcom_time("not-a-time") is None
