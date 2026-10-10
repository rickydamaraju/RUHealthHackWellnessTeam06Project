from datetime import datetime, timezone
from typing import Literal
from uuid import UUID
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class Input(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class Portion(Input):
    food_id: str = Field(min_length=1, max_length=40)
    grams: float = Field(gt=0, le=10000)


class MealInput(Input):
    request_id: UUID
    description: str = Field(default="", max_length=2000)
    eaten_at: datetime
    foods: list[Portion] = Field(min_length=1, max_length=30)
    entry_method: Literal["search", "text"] = "search"

    @field_validator("eaten_at")
    @classmethod
    def require_timezone(cls, value: datetime) -> datetime:
        if value.tzinfo is None:
            raise ValueError("Meal timestamp must include its timezone offset.")
        return value.astimezone(timezone.utc)


class TextInput(Input):
    text: str = Field(min_length=3, max_length=2000)


class ImportInput(Input):
    filename: str = Field(min_length=1, max_length=200, pattern=r"(?i)^.*\.csv$")
    unit: Literal["mg/dL", "mmol/L"]


class PredictionInput(Input):
    meal_id: UUID


class CurvePoint(Input):
    minutes: int = Field(ge=0, le=120)
    glucose_mg_dl: float = Field(gt=0)


class ModelOutput(Input):
    model_version: str = Field(min_length=1)
    curve: list[CurvePoint] = Field(min_length=4)
    baseline_mg_dl: float = Field(gt=0)
    feature_contributions: list[dict] = Field(default_factory=list)
    uncertainty: dict | None = None
    quality_flags: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def require_prediction_horizons(self):
        minutes = [point.minutes for point in self.curve]
        if sorted(minutes) != [30, 60, 90, 120]:
            raise ValueError("The model must return one point at 30, 60, 90, and 120 minutes.")
        return self


def timestamp(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
