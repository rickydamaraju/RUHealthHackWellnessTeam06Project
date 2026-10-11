import json
import os
from datetime import datetime, timezone
from decimal import Decimal
from functools import lru_cache
from uuid import uuid4
import boto3
from boto3.dynamodb.conditions import Key
from boto3.dynamodb.types import TypeSerializer
from botocore.config import Config
from botocore.exceptions import ClientError


@lru_cache
def table():
    return boto3.resource("dynamodb").Table(os.environ["TABLE_NAME"])


@lru_cache
def s3():
    return boto3.client("s3", config=Config(signature_version="s3v4"))


def archive_observations(owner: str, source: str, records: list[dict]):
    """Keep an immutable S3 copy of nonempty device batches for model pipelines."""
    if not records:
        return None
    now = datetime.now(timezone.utc)
    key = f"users/{owner}/device-data/{source}/{now:%Y/%m/%d}/{now:%H%M%S}-{uuid4()}.json"
    s3().put_object(
        Bucket=os.environ["DATA_BUCKET"], Key=key,
        Body=json.dumps({"source": source, "synced_at": now.isoformat(), "records": records}, separators=(",", ":")).encode(),
        ContentType="application/json",
    )
    return key


def pack(value):
    return json.loads(json.dumps(value), parse_float=Decimal)


def unpack(value):
    return json.loads(json.dumps(value, default=lambda x: float(x) if isinstance(x, Decimal) else str(x)))


def get_record(owner: str, key: str):
    result = table().get_item(Key={"pk": f"USER#{owner}", "sk": key}, ConsistentRead=True)
    return unpack(result["Item"]) if "Item" in result else None


def save_record(owner: str, key: str, data: dict, *, create_only=False):
    item = pack({**data, "pk": f"USER#{owner}", "sk": key})
    args = {"Item": item}
    if create_only:
        args["ConditionExpression"] = "attribute_not_exists(pk)"
    try:
        table().put_item(**args)
        return unpack(item)
    except ClientError as exc:
        if exc.response["Error"]["Code"] == "ConditionalCheckFailedException":
            return None
        raise


def save_meal(owner: str, data: dict):
    """Write lookup and chronological history together; retries cannot lose history."""
    serializer = TypeSerializer()
    keys = [f"MEAL#{data['id']}", f"MEAL_HISTORY#{data['eaten_at']}#{data['id']}"]
    operations = []
    for key in keys:
        item = pack({**data, "pk": f"USER#{owner}", "sk": key})
        operations.append({"Put": {"TableName": os.environ["TABLE_NAME"],
                                  "Item": {k: serializer.serialize(v) for k, v in item.items()},
                                  "ConditionExpression": "attribute_not_exists(pk)"}})
    try:
        boto3.client("dynamodb").transact_write_items(TransactItems=operations)
    except ClientError as exc:
        if exc.response["Error"]["Code"] == "TransactionCanceledException" and get_record(owner, keys[0]):
            return None
        raise
    return data


def list_records(owner: str, prefix: str, limit=100):
    # Bounded history; callers must not treat it as the complete training dataset.
    response = table().query(
        KeyConditionExpression=Key("pk").eq(f"USER#{owner}") & Key("sk").begins_with(prefix),
        Limit=limit, ScanIndexForward=False, ConsistentRead=True,
    )
    return {"items": unpack(response.get("Items", [])), "has_more": "LastEvaluatedKey" in response}


def dexcom_connection_owners():
    """Yield users with Dexcom connection records through the sparse connection index."""
    cursor = None
    while True:
        args = {
            "IndexName": os.environ["CONNECTION_INDEX"],
            "KeyConditionExpression": Key("sk").eq("CONNECTION#DEXCOM"),
            "ProjectionExpression": "pk, #connection_status",
            "ExpressionAttributeNames": {"#connection_status": "status"},
        }
        if cursor:
            args["ExclusiveStartKey"] = cursor
        response = table().query(**args)
        for item in unpack(response.get("Items", [])):
            if item.get("status") in {"connected", "connected_no_data"} and item.get("pk", "").startswith("USER#"):
                yield item["pk"][5:]
        cursor = response.get("LastEvaluatedKey")
        if not cursor:
            return


def readings_before(owner: str, cutoff: str, limit=2016):
    response = table().query(
        KeyConditionExpression=Key("pk").eq(f"USER#{owner}") & Key("sk").between("CGM#", f"CGM#{cutoff}"),
        Limit=limit, ScanIndexForward=False, ConsistentRead=True,
    )
    return unpack(response.get("Items", []))


def meals_before(owner: str, start: str, cutoff: str, limit=200):
    """Return saved meals in a bounded time window for model personalization."""
    response = table().query(
        KeyConditionExpression=Key("pk").eq(f"USER#{owner}") & Key("sk").between(
            f"MEAL_HISTORY#{start}", f"MEAL_HISTORY#{cutoff}\uffff"
        ),
        Limit=limit, ScanIndexForward=True, ConsistentRead=True,
    )
    return unpack(response.get("Items", []))


def activity_before(owner: str, cutoff: str, limit=2016):
    response = table().query(
        KeyConditionExpression=Key("pk").eq(f"USER#{owner}") & Key("sk").between("ACTIVITY#", f"ACTIVITY#{cutoff}"),
        Limit=limit, ScanIndexForward=False, ConsistentRead=True,
    )
    return unpack(response.get("Items", []))


def health_before(owner: str, start: str, cutoff: str, limit=10000):
    items, cursor = [], None
    while len(items) < limit:
        args = {
            "KeyConditionExpression": Key("pk").eq(f"USER#{owner}") & Key("sk").between(f"HEALTH#{start}", f"HEALTH#{cutoff}\uffff"),
            "Limit": min(1000, limit - len(items)), "ScanIndexForward": False, "ConsistentRead": True,
        }
        if cursor:
            args["ExclusiveStartKey"] = cursor
        response = table().query(**args)
        items.extend(response.get("Items", []))
        cursor = response.get("LastEvaluatedKey")
        if not cursor:
            break
    return unpack(items)


def public_record(item: dict):
    return {key: value for key, value in item.items() if key not in {"pk", "sk", "object_key", "preview_key", "request_hash"}}
