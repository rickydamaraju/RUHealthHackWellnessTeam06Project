from fastapi import HTTPException
from starlette.requests import Request
from app.main import identity


def request_with_claims(claims):
    return Request({
        "type": "http", "method": "GET", "path": "/me", "headers": [],
        "requestContext": {},
        "aws.event": {},
    } | {"aws.event": {"requestContext": {"authorizer": {"jwt": {"claims": claims}}}}})


def test_identity_uses_api_gateway_verified_subject():
    assert identity(request_with_claims({"sub": "participant-1", "token_use": "access"})) == "participant-1"


def test_identity_rejects_missing_access_token_claims():
    try:
        identity(request_with_claims({"sub": "participant-1", "token_use": "id"}))
        assert False, "expected HTTPException"
    except HTTPException as exc:
        assert exc.status_code == 401
