"""Server-side Dexcom OAuth and retrospective EGV synchronization."""
import json
import os
import secrets
import time
from datetime import datetime, timedelta, timezone
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

import boto3
from fastapi import HTTPException

from . import storage
from .schemas import timestamp


def configuration() -> dict | None:
    secret_arn = os.environ.get("DEXCOM_SECRET_ARN")
    if not secret_arn:
        return None
    try:
        raw = boto3.client("secretsmanager").get_secret_value(SecretId=secret_arn).get("SecretString", "{}")
        value = json.loads(raw)
    except Exception:
        return None
    required = ("client_id", "client_secret", "redirect_uri")
    if not all(isinstance(value.get(key), str) and value[key].strip() for key in required):
        return None
    environment = value.get("environment", "sandbox")
    if environment not in {"sandbox", "production"}:
        return None
    return {**value, "environment": environment}


def base_url(config: dict) -> str:
    return "https://api.dexcom.com" if config["environment"] == "production" else "https://sandbox-api.dexcom.com"


def status(owner: str) -> dict:
    config = configuration()
    record = storage.get_record(owner, "CONNECTION#DEXCOM")
    if not config:
        return {"configured": False, "status": "unavailable", "reading_count": 0}
    if not record:
        return {"configured": True, "status": "not_connected", "reading_count": 0}
    return {
        "configured": True,
        "status": record.get("status", "not_connected"),
        "reading_count": int(record.get("reading_count", 0)),
        "last_synced_at": record.get("last_synced_at"),
        "last_reading_at": record.get("last_reading_at"),
    }


def authorization_url(owner: str) -> str:
    config = configuration()
    if not config:
        raise HTTPException(503, {"code": "dexcom_not_configured", "message": "Dexcom developer credentials have not been configured in AWS yet."})
    state = secrets.token_urlsafe(32)
    expires_at = int(time.time()) + 10 * 60
    storage.table().put_item(Item={
        "pk": f"DEXCOM_STATE#{state}", "sk": "OAUTH", "owner": owner,
        "expires_at": expires_at, "redirect_uri": config["redirect_uri"],
    })
    query = urlencode({
        "client_id": config["client_id"], "redirect_uri": config["redirect_uri"],
        "response_type": "code", "scope": "offline_access", "state": state,
    })
    return f"{base_url(config)}/v3/oauth2/login?{query}"


def finish_authorization(state: str, code: str | None, error: str | None) -> str:
    response = storage.table().get_item(Key={"pk": f"DEXCOM_STATE#{state}", "sk": "OAUTH"}, ConsistentRead=True)
    pending = storage.unpack(response.get("Item", {}))
    if not pending or pending.get("expires_at", 0) < int(time.time()):
        raise HTTPException(400, "This Dexcom connection request expired. Return to the app and try again.")
    storage.table().delete_item(Key={"pk": f"DEXCOM_STATE#{state}", "sk": "OAUTH"})
    owner = pending["owner"]
    if error or not code:
        storage.save_record(owner, "CONNECTION#DEXCOM", {"status": "denied", "updated_at": timestamp(datetime.now(timezone.utc)), "reading_count": 0})
        return "denied"
    config = configuration()
    if not config:
        raise HTTPException(503, "Dexcom integration is unavailable.")
    tokens = _token_request(config, {
        "grant_type": "authorization_code", "code": code, "redirect_uri": pending["redirect_uri"],
        "client_id": config["client_id"], "client_secret": config["client_secret"],
    })
    now = int(time.time())
    storage.save_record(owner, "CONNECTION#DEXCOM", {
        "status": "connected", "access_token": tokens["access_token"], "refresh_token": tokens["refresh_token"],
        "access_expires_at": now + int(tokens.get("expires_in", 7200)) - 60,
        "updated_at": timestamp(datetime.now(timezone.utc)), "reading_count": 0,
    })
    return "connected"


def sync(owner: str) -> dict:
    config = configuration()
    connection = storage.get_record(owner, "CONNECTION#DEXCOM")
    if not config:
        raise HTTPException(503, {"code": "dexcom_not_configured", "message": "Dexcom developer credentials have not been configured in AWS yet."})
    if not connection or connection.get("status") not in {"connected", "connected_no_data"}:
        raise HTTPException(409, {"code": "dexcom_not_connected", "message": "Connect a Dexcom account before synchronizing glucose readings."})
    if connection.get("access_expires_at", 0) <= int(time.time()):
        try:
            tokens = _token_request(config, {
                "grant_type": "refresh_token", "refresh_token": connection["refresh_token"],
                "client_id": config["client_id"], "client_secret": config["client_secret"],
            })
        except HTTPException:
            storage.save_record(owner, "CONNECTION#DEXCOM", {"status": "reauthorization_required", "updated_at": timestamp(datetime.now(timezone.utc)), "reading_count": connection.get("reading_count", 0)})
            raise HTTPException(401, {"code": "dexcom_reauthorization_required", "message": "Dexcom access expired or was revoked. Connect the account again."}) from None
        connection.update({
            "access_token": tokens["access_token"], "refresh_token": tokens["refresh_token"],
            "access_expires_at": int(time.time()) + int(tokens.get("expires_in", 7200)) - 60,
        })
    # Sandbox profiles do not all expose data for the current wall-clock week.
    # dataRange also avoids guessing in production and lets us request the most
    # recent seven days that the selected Dexcom account actually has.
    available = _json_request(f"{base_url(config)}/v3/users/self/dataRange", connection["access_token"])
    egv_range = available.get("egvs") if isinstance(available.get("egvs"), dict) else {}
    first = _dexcom_datetime((egv_range.get("start") or {}).get("systemTime"))
    latest = _dexcom_datetime((egv_range.get("end") or {}).get("systemTime"))
    previous_reading = _dexcom_datetime(connection.get("last_reading_at"))
    if first and latest:
        end = latest + timedelta(seconds=1)  # endDate is exclusive; include the latest observation.
        start = max(first, end - timedelta(days=7), previous_reading or first)
    else:
        end = datetime.now(timezone.utc).replace(microsecond=0)
        start = end - timedelta(days=7)
    query = urlencode({"startDate": start.strftime("%Y-%m-%dT%H:%M:%S"), "endDate": end.strftime("%Y-%m-%dT%H:%M:%S")})
    payload = _json_request(f"{base_url(config)}/v3/users/self/egvs?{query}", connection["access_token"])
    records = []
    for item in payload.get("records", []):
        value = item.get("value")
        observed_at = _dexcom_datetime(item.get("systemTime"))
        if not isinstance(value, (int, float)) or isinstance(value, bool) or value <= 0 or not observed_at:
            continue
        # Dexcom may return the observation at startDate again. Only archive
        # and write samples newer than the last successfully stored reading.
        if previous_reading and observed_at <= previous_reading:
            continue
        when = timestamp(observed_at)
        records.append({
            "timestamp": when, "glucose_mg_dl": float(value), "source": "dexcom",
            "source_id": str(item.get("recordId", "")),
        })
    with storage.table().batch_writer(overwrite_by_pkeys=["pk", "sk"]) as batch:
        for item in records:
            batch.put_item(Item=storage.pack({"pk": f"USER#{owner}", "sk": f"CGM#{item['timestamp']}", **item}))
    storage.archive_observations(owner, "dexcom", records)
    synced_at = timestamp(datetime.now(timezone.utc))
    had_readings = bool(connection.get("last_reading_at")) or int(connection.get("reading_count", 0)) > 0
    connection.update({
        "status": "connected" if records or had_readings else "connected_no_data", "last_synced_at": synced_at,
        "last_reading_at": max((item["timestamp"] for item in records), default=connection.get("last_reading_at")),
        "reading_count": int(connection.get("reading_count", 0)) + len(records), "updated_at": synced_at,
    })
    storage.save_record(owner, "CONNECTION#DEXCOM", connection)
    return {"accepted": len(records), "status": connection["status"], "synced_at": synced_at, "last_reading_at": connection.get("last_reading_at")}


def _token_request(config: dict, form: dict) -> dict:
    request = Request(f"{base_url(config)}/v3/oauth2/token", data=urlencode(form).encode(), headers={"Content-Type": "application/x-www-form-urlencoded"}, method="POST")
    result = _open_json(request)
    if not result.get("access_token") or not result.get("refresh_token"):
        raise HTTPException(502, "Dexcom returned an incomplete authorization response.")
    return result


def _json_request(url: str, access_token: str) -> dict:
    return _open_json(Request(url, headers={"Authorization": f"Bearer {access_token}", "Accept": "application/json"}))


def _open_json(request: Request) -> dict:
    try:
        with urlopen(request, timeout=15) as response:
            return json.loads(response.read())
    except (HTTPError, URLError, TimeoutError, ValueError):
        raise HTTPException(502, "Dexcom could not be reached. Try again later.") from None


def _dexcom_time(value) -> str | None:
    parsed = _dexcom_datetime(value)
    return timestamp(parsed) if parsed else None


def _dexcom_datetime(value) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)
    except ValueError:
        return None
