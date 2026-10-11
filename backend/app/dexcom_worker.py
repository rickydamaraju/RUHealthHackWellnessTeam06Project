"""Scheduled five-minute synchronization for every connected Dexcom user."""
from fastapi import HTTPException

from . import dexcom, storage


def handler(event, context):
    attempted = synchronized = failed = accepted = 0
    for owner in storage.dexcom_connection_owners():
        attempted += 1
        try:
            result = dexcom.sync(owner)
            synchronized += 1
            accepted += int(result.get("accepted", 0))
        except HTTPException:
            # dexcom.sync records reauthorization state when a refresh token
            # is rejected. A later schedule can retry temporary upstream errors.
            failed += 1
        except Exception:
            failed += 1
    if failed:
        # Raise only after processing every user. EventBridge retries temporary
        # failures and the Lambda Errors metric activates the deployment alarm.
        raise RuntimeError(f"Dexcom synchronization failed for {failed} of {attempted} connected users.")
    return {
        "attempted": attempted,
        "synchronized": synchronized,
        "failed": failed,
        "accepted": accepted,
    }
