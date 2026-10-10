"""Screen explanation text after model integration; never modify model numbers."""
import os
import boto3
from botocore.config import Config

FALLBACK = "This estimate is unavailable for interpretation. It must not be used for diagnosis or medication decisions."


def screen_explanation(text: str):
    guardrail_id = os.environ.get("GUARDRAIL_ID")
    version = os.environ.get("GUARDRAIL_VERSION")
    if not guardrail_id or not version:
        return {"text": FALLBACK, "status": "unavailable"}
    try:
        response = boto3.client("bedrock-runtime", config=Config(connect_timeout=3, read_timeout=8, retries={"max_attempts": 0})).apply_guardrail(
            guardrailIdentifier=guardrail_id, guardrailVersion=version,
            source="OUTPUT", content=[{"text": {"text": text}}],
        )
    except Exception:
        return {"text": FALLBACK, "status": "unavailable"}
    if response["action"] != "NONE":
        return {"text": FALLBACK, "status": "blocked"}
    return {"text": text, "status": "passed"}
