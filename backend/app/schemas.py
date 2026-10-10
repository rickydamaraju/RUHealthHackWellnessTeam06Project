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
    entry_method: Literal["search", "text", "photo"] = "search"
    photo_id: UUID | None = None

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


class ActivityImportInput(Input):
    filename: str = Field(min_length=1, max_length=200, pattern=r"(?i)^.*\.(csv|zip)$")
    content_type: Literal["text/csv", "application/zip"]


class ProfileInput(Input):
    first_name: str = Field(min_length=1, max_length=80)
    last_name: str = Field(min_length=1, max_length=80)
    age: int = Field(ge=1, le=120)
    height: float = Field(gt=0)
    height_unit: Literal["cm", "in"]
    weight: float = Field(gt=0)
    weight_unit: Literal["kg", "lb"]
    diabetes_status: Literal["type_1", "type_2", "unknown", "no_diabetes"]

    @field_validator("first_name", "last_name")
    @classmethod
    def require_name(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Enter a name.")
        return value

    @model_validator(mode="after")
    def validate_measurements(self):
        height_cm = self.height if self.height_unit == "cm" else self.height * 2.54
        weight_kg = self.weight if self.weight_unit == "kg" else self.weight * 0.45359237
        if not 50 <= height_cm <= 250:
            raise ValueError("Height must be between 50 and 250 centimeters.")
        if not 20 <= weight_kg <= 500:
            raise ValueError("Weight must be between 20 and 500 kilograms.")
        return self


class HealthSampleInput(Input):
    source_id: str = Field(min_length=1, max_length=200)
    metric: Literal["heart_rate_bpm", "steps", "basal_energy_kcal", "active_energy_kcal"]
    start_at: datetime
    end_at: datetime
    value: float = Field(ge=0)

    @model_validator(mode="after")
    def validate_times(self):
        if self.start_at.tzinfo is None or self.end_at.tzinfo is None:
            raise ValueError("Health sample timestamps must include timezone offsets.")
        if self.end_at < self.start_at:
            raise ValueError("A health sample cannot end before it starts.")
        return self


class WorkoutInput(Input):
    source_id: str = Field(min_length=1, max_length=200)
    activity_type: str = Field(min_length=1, max_length=100)
    start_at: datetime
    end_at: datetime
    duration_seconds: float = Field(ge=0, le=7 * 24 * 3600)
    energy_kcal: float | None = Field(default=None, ge=0, le=100000)

    @model_validator(mode="after")
    def validate_times(self):
        if self.start_at.tzinfo is None or self.end_at.tzinfo is None:
            raise ValueError("Workout timestamps must include timezone offsets.")
        if self.end_at < self.start_at:
            raise ValueError("A workout cannot end before it starts.")
        return self


class HealthSyncInput(Input):
    samples: list[HealthSampleInput] = Field(default_factory=list, max_length=1000)
    workouts: list[WorkoutInput] = Field(default_factory=list, max_length=250)
    anchor: str | None = Field(default=None, max_length=4000)

    @model_validator(mode="after")
    def require_data(self):
        if not self.samples and not self.workouts:
            raise ValueError("Include at least one health sample or workout.")
        return self


class PhotoUploadInput(Input):
    filename: str = Field(min_length=1, max_length=200)
    content_type: Literal[
        "image/jpeg", "image/png", "image/webp", "image/gif", "image/heic", "image/heif",
        "image/avif", "image/bmp", "image/tiff",
    ]
    size_bytes: int = Field(gt=0, le=15 * 1024 * 1024)


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
