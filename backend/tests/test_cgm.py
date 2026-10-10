import pytest
from app.cgm import InvalidCGM, parse_csv


def test_parses_and_sorts_mg_dl_readings():
    data = b"timestamp,glucose\n2026-01-01T12:05:00-05:00,110\n2026-01-01T12:00:00-05:00,100\n"
    assert parse_csv(data, "mg/dL") == [
        {"timestamp": "2026-01-01T17:00:00Z", "glucose_mg_dl": 100.0},
        {"timestamp": "2026-01-01T17:05:00Z", "glucose_mg_dl": 110.0},
    ]


def test_converts_mmol_l_to_mg_dl():
    readings = parse_csv(b"timestamp,glucose\n2026-01-01T17:00:00Z,5.5\n", "mmol/L")
    assert readings[0]["glucose_mg_dl"] == pytest.approx(99.1, abs=0.01)


@pytest.mark.parametrize("data", [
    b"timestamp,glucose\n2026-01-01T12:00:00,100\n",
    b"timestamp,glucose\n2026-01-01T12:00:00Z,-1\n",
    b"time,value\n2026-01-01T12:00:00Z,100\n",
])
def test_rejects_unsafe_or_ambiguous_rows(data):
    with pytest.raises(InvalidCGM):
        parse_csv(data, "mg/dL")
