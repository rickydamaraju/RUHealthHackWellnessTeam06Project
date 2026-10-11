import hashlib
import json
import os
import time
from urllib.parse import unquote_plus
from uuid import UUID
from botocore.exceptions import ClientError
from . import storage
from .activity import InvalidActivity, parse_apple_health_zip, parse_csv as parse_activity_csv
from .cgm import InvalidCGM, parse_csv


def process(record):
    if record.get("eventSource") != "aws:s3":
        return
    bucket = record["s3"]["bucket"]["name"]
    key = unquote_plus(record["s3"]["object"]["key"])
    parts = key.split("/")
    if bucket != os.environ["DATA_BUCKET"] or len(parts) != 4 or parts[0] != "users" or parts[2] not in {"imports", "activity-imports"}:
        return
    owner, filename = parts[1], parts[3]
    activity = parts[2] == "activity-imports"
    try:
        import_id = str(UUID(filename.rsplit(".", 1)[0]))
    except ValueError:
        return
    record_prefix = "ACTIVITY_IMPORT" if activity else "IMPORT"
    item = storage.get_record(owner, f"{record_prefix}#{import_id}")
    if not item or item.get("object_key") != key or item.get("status") in {"ready", "failed"}:
        return
    try:
        storage.table().update_item(
            Key={"pk": f"USER#{owner}", "sk": f"{record_prefix}#{import_id}"},
            UpdateExpression="SET #s = :processing, lease_until = :lease",
            ConditionExpression="#s = :awaiting OR (#s = :processing AND lease_until < :now)",
            ExpressionAttributeNames={"#s": "status"},
            ExpressionAttributeValues={":processing": "processing", ":awaiting": "awaiting_upload", ":lease": int(time.time()) + 130, ":now": int(time.time())},
        )
    except ClientError as exc:
        if exc.response["Error"]["Code"] == "ConditionalCheckFailedException":
            # Retry after the visibility timeout if another attempt owns the lease.
            raise RuntimeError("Import is being processed") from None
        raise
    kwargs = {"Bucket": bucket, "Key": key}
    if record["s3"]["object"].get("versionId"):
        kwargs["VersionId"] = record["s3"]["object"]["versionId"]
    response = storage.s3().get_object(**kwargs)
    try:
        limit = (250 if filename.lower().endswith(".zip") else 50) * 1024 * 1024 if activity else 10 * 1024 * 1024
        if response["ContentLength"] > limit:
            raise (InvalidActivity("The activity file exceeds its upload limit.") if activity else InvalidCGM("The CSV exceeds the 10 MB limit."))
        data = response["Body"].read(limit + 1)
        if activity:
            readings = parse_apple_health_zip(data) if filename.lower().endswith(".zip") else parse_activity_csv(data)
        else:
            readings = parse_csv(data, item["unit"])
    except (InvalidCGM, InvalidActivity) as exc:
        storage.save_record(owner, f"{record_prefix}#{import_id}", {**item, "status": "failed", "error": str(exc)})
        return
    finally:
        response["Body"].close()
    # Per-timestamp keys make retried writes idempotent. The raw S3 version is retained.
    with storage.table().batch_writer() as batch:
        for reading in readings:
            prefix = "ACTIVITY" if activity else "CGM"
            source = "activity_upload" if activity else "cgm_upload"
            batch.put_item(Item=storage.pack({"pk": f"USER#{owner}", "sk": f"{prefix}#{reading['timestamp']}", **reading, "import_id": import_id, "source": source}))
    prepared_key = f"prepared/{owner}/{'activity/' if activity else ''}{import_id}.json"
    storage.s3().put_object(Bucket=bucket, Key=prepared_key, Body=json.dumps(readings).encode(), ContentType="application/json")
    storage.save_record(owner, f"{record_prefix}#{import_id}", {
        **item, "status": "ready", "reading_count": len(readings),
        "source_sha256": hashlib.sha256(data).hexdigest(), "source_version": kwargs.get("VersionId"),
        "start": readings[0]["timestamp"], "end": readings[-1]["timestamp"],
    })


def handler(event, context):
    failures = []
    for message in event.get("Records", []):
        try:
            notification = json.loads(message["body"])
            for record in notification.get("Records", []):
                process(record)
        except Exception:
            # SQS retries and then routes to the DLQ; no participant data is logged.
            failures.append({"itemIdentifier": message["messageId"]})
    return {"batchItemFailures": failures}
