import csv
import io
import math
from datetime import datetime
from .schemas import timestamp


class InvalidCGM(ValueError):
    pass


def parse_csv(data: bytes, unit: str):
    if not data or len(data) > 10 * 1024 * 1024:
        raise InvalidCGM("Upload a nonempty CSV smaller than 10 MB.")
    try:
        reader = csv.DictReader(io.StringIO(data.decode("utf-8-sig")))
        if not reader.fieldnames or not {"timestamp", "glucose"}.issubset(reader.fieldnames):
            raise InvalidCGM("The initial CSV format requires timestamp and glucose columns.")
        readings = {}
        for line, row in enumerate(reader, start=2):
            if line > 20001:
                raise InvalidCGM("This version supports up to 20,000 readings per file.")
            try:
                when = datetime.fromisoformat(row["timestamp"].strip().replace("Z", "+00:00"))
                if when.tzinfo is None:
                    raise ValueError("timezone")
                glucose = float(row["glucose"])
                if unit == "mmol/L":
                    glucose *= 18.0182
                elif unit != "mg/dL":
                    raise ValueError("unit")
                if not math.isfinite(glucose) or glucose <= 0:
                    raise ValueError("glucose")
            except (ValueError, TypeError, AttributeError):
                raise InvalidCGM(f"Row {line} needs a timestamp with timezone and a positive numeric glucose value.") from None
            key, value = timestamp(when), round(glucose, 3)
            if key in readings and readings[key] != value:
                raise InvalidCGM(f"Row {line} conflicts with another reading at the same timestamp.")
            readings[key] = value
    except UnicodeDecodeError:
        raise InvalidCGM("The CSV must use UTF-8 text encoding.") from None
    if not readings:
        raise InvalidCGM("The CSV contains no readings.")
    return [{"timestamp": t, "glucose_mg_dl": g} for t, g in sorted(readings.items())]
