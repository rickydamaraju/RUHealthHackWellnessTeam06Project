import hashlib
import json
import os
from datetime import datetime, timezone
from uuid import UUID, uuid4
from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.responses import RedirectResponse
from mangum import Mangum
from . import catalog, dexcom, insights, meal_photo, meal_text, model_adapter, storage
from .schemas import ActivityImportInput, HealthSyncInput, ImportInput, MealInput, PhotoUploadInput, PredictionInput, PredictionInsightInput, PredictionMealInput, ProfileInput, TextInput, timestamp

app = FastAPI(title="Glucose Compass API", version="0.1.0", docs_url=None, redoc_url=None, openapi_url=None)


def identity(request: Request) -> str:
    # API Gateway validates signature, issuer, client, expiry, and required scope.
    # The event is supplied by Mangum, never copied from request headers/body.
    event = request.scope.get("aws.event", {})
    claims = event.get("requestContext", {}).get("authorizer", {}).get("jwt", {}).get("claims", {})
    subject = claims.get("sub")
    if claims.get("token_use") != "access" or not subject:
        raise HTTPException(401, "Sign in to access your account.")
    return subject


@app.get("/health")
def health():
    return {"status": "ok", "version": "0.1.0"}


@app.get("/me")
def me(owner: str = Depends(identity)):
    return {"id": owner, "model_connected": bool(os.environ.get("MODEL_ENDPOINT_NAME")), "text_interpretation_enabled": bool(os.environ.get("BEDROCK_MODEL_ID"))}


@app.get("/connections")
def connections(owner: str = Depends(identity)):
    health_sync = storage.get_record(owner, "HEALTH_SYNC")
    return {
        "apple_health": {
            "status": ("connected" if health_sync.get("record_count", 0) else "connected_no_data") if health_sync else "not_connected",
            "record_count": int(health_sync.get("record_count", 0)) if health_sync else 0,
            "last_synced_at": health_sync.get("synced_at") if health_sync else None,
        },
        "dexcom": dexcom.status(owner),
    }


@app.post("/connections/dexcom/start")
def start_dexcom(owner: str = Depends(identity)):
    return {"authorization_url": dexcom.authorization_url(owner)}


@app.get("/integrations/dexcom/callback")
def dexcom_callback(state: str = Query(min_length=20, max_length=200), code: str | None = None, error: str | None = None):
    result = dexcom.finish_authorization(state, code, error)
    return RedirectResponse(f"glucosecompass://integrations/dexcom?status={result}", status_code=302)


@app.post("/connections/dexcom/sync")
def sync_dexcom(owner: str = Depends(identity)):
    return dexcom.sync(owner)


@app.get("/profile")
def get_profile(owner: str = Depends(identity)):
    found = storage.get_record(owner, "PROFILE")
    return {"profile": storage.public_record(found) if found else None}


@app.post("/profile")
def save_profile(body: ProfileInput, owner: str = Depends(identity)):
    now = timestamp(datetime.now(timezone.utc))
    existing = storage.get_record(owner, "PROFILE")
    values = body.model_dump()
    values["first_name"] = values["first_name"].strip()
    values["last_name"] = values["last_name"].strip()
    values["height_cm"] = round(body.height if body.height_unit == "cm" else body.height * 2.54, 2)
    values["weight_kg"] = round(body.weight if body.weight_unit == "kg" else body.weight * 0.45359237, 2)
    saved = {**values, "created_at": existing.get("created_at", now) if existing else now, "updated_at": now}
    storage.save_record(owner, "PROFILE", saved)
    return storage.public_record(saved)


@app.get("/foods")
def foods(q: str = Query(min_length=2, max_length=120), owner: str = Depends(identity)):
    return {"items": catalog.search(q), "source": "USDA FNDDS 2021–2023"}


@app.post("/meals/interpret")
def interpret_meal(body: TextInput, owner: str = Depends(identity)):
    return meal_text.interpret(body.text)


@app.post("/meals")
def create_meal(body: MealInput, owner: str = Depends(identity)):
    request_hash = hashlib.sha256(body.model_dump_json().encode()).hexdigest()
    key = f"MEAL#{body.request_id}"
    existing = storage.get_record(owner, key)
    if existing:
        if existing["request_hash"] != request_hash:
            raise HTTPException(409, "This save identifier was already used for a different meal.")
        return storage.public_record(existing)
    photo = None
    if body.photo_id:
        photo_record = storage.get_record(owner, f"PHOTO#{body.photo_id}")
        if not photo_record or photo_record.get("status") != "ready":
            raise HTTPException(422, "Upload the selected meal photo before saving the meal.")
        photo = {key: photo_record[key] for key in ("id", "filename", "content_type", "size_bytes", "status")}
    foods, nutrition = catalog.meal_nutrition(body.foods)
    data = {
        "id": str(body.request_id), "description": body.description.strip(),
        "eaten_at": timestamp(body.eaten_at), "created_at": timestamp(datetime.now(timezone.utc)),
        "foods": foods, "nutrition": nutrition, "entry_method": body.entry_method,
        "request_hash": request_hash,
    }
    if photo:
        data["photo"] = photo
    result = storage.save_meal(owner, data)
    if result is None:
        existing = storage.get_record(owner, key)
        if not existing or existing.get("request_hash") != request_hash:
            raise HTTPException(409, "This save identifier was already used for a different meal.")
        return storage.public_record(existing)
    return storage.public_record(result)


@app.get("/meals")
def meals(owner: str = Depends(identity)):
    result = storage.list_records(owner, "MEAL_HISTORY#")
    return {**result, "items": [storage.public_record(x) for x in result["items"]]}


@app.get("/meals/{meal_id}")
def meal(meal_id: UUID, owner: str = Depends(identity)):
    found = storage.get_record(owner, f"MEAL#{meal_id}")
    if not found:
        raise HTTPException(404, "Meal not found.")
    return storage.public_record(found)


@app.post("/meal-photos")
def start_meal_photo(body: PhotoUploadInput, owner: str = Depends(identity)):
    photo_id = str(uuid4())
    extension = {
        "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif",
        "image/heic": "heic", "image/heif": "heif", "image/avif": "avif", "image/bmp": "bmp",
        "image/tiff": "tiff",
    }[body.content_type]
    key = f"users/{owner}/meal-photos/{photo_id}.{extension}"
    data = {
        "id": photo_id, "filename": body.filename, "content_type": body.content_type,
        "size_bytes": body.size_bytes, "status": "awaiting_upload",
        "created_at": timestamp(datetime.now(timezone.utc)), "object_key": key,
    }
    storage.save_record(owner, f"PHOTO#{photo_id}", data, create_only=True)
    upload = storage.s3().generate_presigned_post(
        Bucket=os.environ["DATA_BUCKET"], Key=key,
        Fields={"Content-Type": body.content_type},
        Conditions=[{"Content-Type": body.content_type}, ["content-length-range", 1, 15 * 1024 * 1024]],
        ExpiresIn=300,
    )
    return {"photo": storage.public_record(data), "upload": upload}


@app.post("/meal-photos/{photo_id}/complete")
def complete_meal_photo(photo_id: UUID, owner: str = Depends(identity)):
    record = storage.get_record(owner, f"PHOTO#{photo_id}")
    if not record:
        raise HTTPException(404, "Meal photo not found.")
    try:
        uploaded = storage.s3().head_object(Bucket=os.environ["DATA_BUCKET"], Key=record["object_key"])
    except Exception:
        raise HTTPException(409, "The meal photo has not finished uploading. Please try again.") from None
    if uploaded.get("ContentType") != record["content_type"] or uploaded.get("ContentLength", 0) > 15 * 1024 * 1024:
        raise HTTPException(422, "The uploaded image type or size is not supported.")
    ready = {**record, "status": "ready", "size_bytes": uploaded["ContentLength"]}
    storage.save_record(owner, f"PHOTO#{photo_id}", ready)
    return storage.public_record(ready)


@app.post("/meal-photos/{photo_id}/analyze")
def analyze_meal_photo(photo_id: UUID, owner: str = Depends(identity)):
    record = storage.get_record(owner, f"PHOTO#{photo_id}")
    if not record or record.get("status") != "ready":
        raise HTTPException(404, "Upload the meal photo before analyzing it.")
    try:
        image = storage.s3().get_object(Bucket=os.environ["DATA_BUCKET"], Key=record["object_key"])["Body"].read()
    except Exception:
        raise HTTPException(503, "The meal photo could not be opened. Please upload it again.") from None
    normalized, _ = meal_photo._normalize_image(image, record["content_type"])
    preview_key = f"users/{owner}/meal-photos/previews/{photo_id}.jpg"
    storage.s3().put_object(Bucket=os.environ["DATA_BUCKET"], Key=preview_key, Body=normalized, ContentType="image/jpeg")
    storage.save_record(owner, f"PHOTO#{photo_id}", {**record, "preview_key": preview_key})
    result = meal_photo.analyze_jpeg(normalized)
    result["preview_url"] = storage.s3().generate_presigned_url(
        "get_object", Params={"Bucket": os.environ["DATA_BUCKET"], "Key": preview_key}, ExpiresIn=3600,
    )
    return result


@app.get("/meal-photos/{photo_id}/preview")
def meal_photo_preview(photo_id: UUID, owner: str = Depends(identity)):
    record = storage.get_record(owner, f"PHOTO#{photo_id}")
    if not record or not record.get("preview_key"):
        raise HTTPException(404, "Meal photo preview is not ready.")
    return {"preview_url": storage.s3().generate_presigned_url(
        "get_object", Params={"Bucket": os.environ["DATA_BUCKET"], "Key": record["preview_key"]}, ExpiresIn=3600,
    )}


@app.post("/imports")
def start_import(body: ImportInput, owner: str = Depends(identity)):
    import_id = str(uuid4())
    key = f"users/{owner}/imports/{import_id}.csv"
    data = {"id": import_id, "filename": body.filename, "unit": body.unit, "status": "awaiting_upload",
            "created_at": timestamp(datetime.now(timezone.utc)), "object_key": key}
    storage.save_record(owner, f"IMPORT#{import_id}", data)
    upload = storage.s3().generate_presigned_post(
        Bucket=os.environ["DATA_BUCKET"], Key=key,
        Fields={"Content-Type": "text/csv"},
        Conditions=[{"Content-Type": "text/csv"}, ["content-length-range", 1, 10 * 1024 * 1024]], ExpiresIn=300,
    )
    return {"import": storage.public_record(data), "upload": upload}


@app.get("/imports/{import_id}")
def get_import(import_id: UUID, owner: str = Depends(identity)):
    found = storage.get_record(owner, f"IMPORT#{import_id}")
    if not found:
        raise HTTPException(404, "Upload not found.")
    return storage.public_record(found)


@app.get("/cgm")
def cgm(owner: str = Depends(identity)):
    result = storage.list_records(owner, "CGM#", 288)
    return {**result, "items": [storage.public_record(x) for x in reversed(result["items"])]}


@app.post("/activity-imports")
def start_activity_import(body: ActivityImportInput, owner: str = Depends(identity)):
    import_id = str(uuid4())
    extension = "zip" if body.content_type == "application/zip" else "csv"
    key = f"users/{owner}/activity-imports/{import_id}.{extension}"
    data = {"id": import_id, "filename": body.filename, "content_type": body.content_type,
            "status": "awaiting_upload", "created_at": timestamp(datetime.now(timezone.utc)), "object_key": key}
    storage.save_record(owner, f"ACTIVITY_IMPORT#{import_id}", data)
    upload = storage.s3().generate_presigned_post(
        Bucket=os.environ["DATA_BUCKET"], Key=key, Fields={"Content-Type": body.content_type},
        Conditions=[{"Content-Type": body.content_type}, ["content-length-range", 1, (250 if extension == "zip" else 50) * 1024 * 1024]], ExpiresIn=300,
    )
    return {"import": storage.public_record(data), "upload": upload}


@app.get("/activity-imports/{import_id}")
def get_activity_import(import_id: UUID, owner: str = Depends(identity)):
    found = storage.get_record(owner, f"ACTIVITY_IMPORT#{import_id}")
    if not found:
        raise HTTPException(404, "Activity upload not found.")
    return storage.public_record(found)


@app.get("/activity")
def activity(owner: str = Depends(identity)):
    result = storage.list_records(owner, "ACTIVITY#", 288)
    return {**result, "items": [storage.public_record(x) for x in reversed(result["items"])]}


@app.post("/health-data/sync")
def sync_health_data(body: HealthSyncInput, owner: str = Depends(identity)):
    records = []
    for sample in body.samples:
        value = sample.model_dump()
        value.pop("start_at"); value.pop("end_at")
        value["timestamp"] = timestamp(sample.start_at)
        value["end_timestamp"] = timestamp(sample.end_at)
        value["source"] = "apple_health"
        digest = hashlib.sha256(sample.source_id.encode()).hexdigest()[:24]
        records.append((f"HEALTH#{value['timestamp']}#{sample.metric}#{digest}", value))
    for workout in body.workouts:
        value = workout.model_dump()
        value.pop("start_at"); value.pop("end_at")
        value["metric"] = "workout"
        value["timestamp"] = timestamp(workout.start_at)
        value["end_timestamp"] = timestamp(workout.end_at)
        value["source"] = "apple_health"
        digest = hashlib.sha256(workout.source_id.encode()).hexdigest()[:24]
        records.append((f"HEALTH#{value['timestamp']}#workout#{digest}", value))
    with storage.table().batch_writer(overwrite_by_pkeys=["pk", "sk"]) as batch:
        for key, value in records:
            batch.put_item(Item=storage.pack({"pk": f"USER#{owner}", "sk": key, **value}))
    storage.archive_observations(owner, "apple-health", [value for _, value in records])
    synced_at = timestamp(datetime.now(timezone.utc))
    existing = storage.get_record(owner, "HEALTH_SYNC") or {}
    storage.save_record(owner, "HEALTH_SYNC", {
        "anchor": body.anchor, "synced_at": synced_at,
        "record_count": max(int(existing.get("record_count", 0)), len(records)),
        "last_batch_count": len(records),
    })
    return {"accepted": len(records), "synced_at": synced_at}


@app.get("/health-data")
def health_data(owner: str = Depends(identity)):
    result = storage.list_records(owner, "HEALTH#", 500)
    return {**result, "items": [storage.public_record(x) for x in reversed(result["items"])]}


@app.post("/predictions")
def predict(body: PredictionInput, owner: str = Depends(identity)):
    meal = storage.get_record(owner, f"MEAL#{body.meal_id}")
    if not meal:
        raise HTTPException(404, "Meal not found.")
    return model_adapter.predict_and_store(owner, meal)


@app.post("/predictions/meal")
def predict_hypothetical_meal(body: PredictionMealInput, owner: str = Depends(identity)):
    if body.photo_id:
        photo = storage.get_record(owner, f"PHOTO#{body.photo_id}")
        if not photo or photo.get("status") != "ready":
            raise HTTPException(422, "Upload the selected meal photo before requesting a prediction.")
    foods, nutrition = catalog.meal_nutrition(body.foods)
    hypothetical = {
        "id": str(uuid4()), "description": body.description.strip(),
        "eaten_at": timestamp(body.eaten_at), "created_at": timestamp(datetime.now(timezone.utc)),
        "foods": foods, "nutrition": nutrition, "entry_method": body.entry_method,
    }
    return model_adapter.predict_and_store(owner, hypothetical, persist=False, allow_reference_fallback=True)


@app.post("/insights/prediction")
def prediction_insights(body: PredictionInsightInput, owner: str = Depends(identity)):
    # Hypothetical curves are intentionally not persisted. Interpret the displayed
    # numeric evidence in a separate request so Groq cannot delay the graph.
    context = body.model_dump()
    context["kind"] = "predicted"
    peak = max(context["curve"], key=lambda point: point["glucose_mg_dl"])
    context["peak_mg_dl"] = peak["glucose_mg_dl"]
    context["time_to_peak_minutes"] = peak["minutes"]
    return insights.explain(context)


@app.post("/insights")
def overall_insights(owner: str = Depends(identity)):
    readings = list(reversed(storage.list_records(owner, "CGM#", 288)["items"]))
    history = storage.list_records(owner, "MEAL_HISTORY#")
    if len(readings) < 4 or not history["items"]:
        return {"status": "insufficient_data", "message": "Add a meal and at least four glucose readings to explore your patterns."}
    context = insights.history_context(readings, history["items"], history.get("has_more", False))
    if not context["meals"]:
        return {"status": "insufficient_data", "message": "Log a meal within your displayed glucose history to connect macros with the graph."}
    return insights.explain(context)


handler = Mangum(app, lifespan="off")
