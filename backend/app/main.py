import hashlib
import json
import os
from datetime import datetime, timezone
from uuid import UUID, uuid4
from fastapi import Depends, FastAPI, HTTPException, Query, Request
from mangum import Mangum
from . import catalog, meal_text, model_adapter, storage
from .schemas import ImportInput, MealInput, PredictionInput, TextInput, timestamp

app = FastAPI(title="Mini Sathi API", version="0.1.0", docs_url=None, redoc_url=None, openapi_url=None)


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
    foods, nutrition = catalog.meal_nutrition(body.foods)
    data = {
        "id": str(body.request_id), "description": body.description.strip(),
        "eaten_at": timestamp(body.eaten_at), "created_at": timestamp(datetime.now(timezone.utc)),
        "foods": foods, "nutrition": nutrition, "entry_method": body.entry_method,
        "request_hash": request_hash,
    }
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


@app.post("/predictions")
def predict(body: PredictionInput, owner: str = Depends(identity)):
    meal = storage.get_record(owner, f"MEAL#{body.meal_id}")
    if not meal:
        raise HTTPException(404, "Meal not found.")
    return model_adapter.predict_and_store(owner, meal)


handler = Mangum(app, lifespan="off")
