from io import BytesIO
from zipfile import ZipFile

import pytest

from app.activity import InvalidActivity, parse_apple_health_zip, parse_csv


def test_activity_csv_aggregates_five_minute_intervals():
    data = b"timestamp,steps,active_energy_kcal,heart_rate_bpm\n2026-10-10T08:01:00-04:00,10,2,70\n2026-10-10T08:04:00-04:00,20,3,80\n"
    readings = parse_csv(data)
    assert readings == [{"timestamp": "2026-10-10T12:00:00Z", "steps": 30, "active_energy_kcal": 5.0, "heart_rate_bpm": 75.0}]


def test_apple_health_export_extracts_supported_records():
    xml = b'''<HealthData><Record type="HKQuantityTypeIdentifierStepCount" startDate="2026-10-10 08:01:00 -0400" value="42"/><Record type="HKQuantityTypeIdentifierHeartRate" startDate="2026-10-10 08:02:00 -0400" value="77"/><Record type="ignored" startDate="2026-10-10 08:03:00 -0400" value="1"/></HealthData>'''
    output = BytesIO()
    with ZipFile(output, "w") as archive:
        archive.writestr("apple_health_export/export.xml", xml)
    assert parse_apple_health_zip(output.getvalue()) == [{"timestamp": "2026-10-10T12:00:00Z", "steps": 42, "heart_rate_bpm": 77.0}]


def test_activity_csv_requires_a_metric():
    with pytest.raises(InvalidActivity):
        parse_csv(b"timestamp,note\n2026-10-10T08:00:00Z,walk\n")
