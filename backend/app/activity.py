import csv
import io
import math
import zipfile
from collections import defaultdict
from datetime import datetime, timezone
from xml.etree.ElementTree import iterparse


class InvalidActivity(ValueError):
    pass


APPLE_TYPES = {
    "HKQuantityTypeIdentifierStepCount": "steps",
    "HKQuantityTypeIdentifierActiveEnergyBurned": "active_energy_kcal",
    "HKQuantityTypeIdentifierHeartRate": "heart_rate_bpm",
}


def _time(value: str) -> datetime:
    try:
        parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        try:
            parsed = datetime.strptime(value.strip(), "%Y-%m-%d %H:%M:%S %z")
        except ValueError as exc:
            raise InvalidActivity("A timestamp could not be read. Include a timezone offset.") from exc
    if parsed.tzinfo is None:
        raise InvalidActivity("Activity timestamps must include a timezone offset.")
    return parsed.astimezone(timezone.utc)


def _number(value: str, label: str) -> float:
    try:
        result = float(value)
    except (TypeError, ValueError) as exc:
        raise InvalidActivity(f"A {label} value could not be read.") from exc
    if not math.isfinite(result) or result < 0:
        raise InvalidActivity(f"{label} values must be non-negative numbers.")
    return result


def _aggregate(rows):
    buckets = defaultdict(lambda: {"steps": 0.0, "active_energy_kcal": 0.0, "heart_rates": []})
    for when, metric, value in rows:
        minute = when.minute - when.minute % 5
        stamp = when.replace(minute=minute, second=0, microsecond=0)
        if metric == "heart_rate_bpm":
            buckets[stamp]["heart_rates"].append(value)
        else:
            buckets[stamp][metric] += value
    output = []
    for stamp, values in sorted(buckets.items()):
        item = {"timestamp": stamp.isoformat(timespec="seconds").replace("+00:00", "Z")}
        if values["steps"]:
            item["steps"] = round(values["steps"])
        if values["active_energy_kcal"]:
            item["active_energy_kcal"] = round(values["active_energy_kcal"], 2)
        if values["heart_rates"]:
            item["heart_rate_bpm"] = round(sum(values["heart_rates"]) / len(values["heart_rates"]), 1)
        output.append(item)
    if not output:
        raise InvalidActivity("No supported Apple Watch activity records were found.")
    return output


def parse_csv(data: bytes):
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise InvalidActivity("The activity CSV must use UTF-8 text.") from exc
    reader = csv.DictReader(io.StringIO(text))
    fields = set(reader.fieldnames or [])
    metrics = {"steps", "active_energy_kcal", "heart_rate_bpm"} & fields
    if "timestamp" not in fields or not metrics:
        raise InvalidActivity("Use timestamp plus at least one of: steps, active_energy_kcal, heart_rate_bpm.")
    rows = []
    for index, row in enumerate(reader, 2):
        if index > 50002:
            raise InvalidActivity("The activity CSV exceeds 50,000 rows.")
        when = _time(row.get("timestamp", ""))
        for metric in metrics:
            if row.get(metric, "").strip():
                rows.append((when, metric, _number(row[metric], metric)))
    return _aggregate(rows)


def parse_apple_health_zip(data: bytes):
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as exc:
        raise InvalidActivity("This is not a valid Apple Health export ZIP.") from exc
    candidates = [item for item in archive.infolist() if item.filename.endswith("export.xml")]
    if not candidates:
        raise InvalidActivity("The ZIP does not contain Apple Health export.xml.")
    info = candidates[0]
    if info.file_size > 250 * 1024 * 1024 or info.flag_bits & 1:
        raise InvalidActivity("The Apple Health export is too large or encrypted.")
    rows = []
    try:
        with archive.open(info) as source:
            for _, element in iterparse(source, events=("end",)):
                if element.tag == "Record" and element.attrib.get("type") in APPLE_TYPES:
                    metric = APPLE_TYPES[element.attrib["type"]]
                    rows.append((_time(element.attrib.get("startDate", "")), metric, _number(element.attrib.get("value", ""), metric)))
                    if len(rows) > 250000:
                        raise InvalidActivity("The export contains more than 250,000 supported records.")
                element.clear()
    except (KeyError, OSError) as exc:
        raise InvalidActivity("The Apple Health export could not be read.") from exc
    return _aggregate(rows)
