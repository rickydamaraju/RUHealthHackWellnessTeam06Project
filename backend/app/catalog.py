import json
import re
from functools import lru_cache
from pathlib import Path
from fastapi import HTTPException


@lru_cache
def catalog():
    path = Path(__file__).parent / "data" / "catalog.json"
    return {food["id"]: food for food in json.loads(path.read_text())["foods"]}


def search(query: str, limit=20):
    tokens = re.findall(r"[a-z0-9]+", query.lower())[:8]
    if not tokens:
        return []
    candidates = [f for f in catalog().values() if all(t in f["name"].lower() for t in tokens)]
    return sorted(candidates, key=lambda f: (not f["name"].lower().startswith(query.lower()), len(f["name"])))[:limit]


def meal_nutrition(portions):
    foods, totals = [], {k: 0.0 for k in ("carbs_g", "protein_g", "fat_g", "fiber_g", "calories")}
    for portion in portions:
        food = catalog().get(portion.food_id)
        if not food:
            raise HTTPException(422, "One of the selected foods is not in the catalog. Search and select it again.")
        scaled = {key: round(food["per_100g"][key] * portion.grams / 100, 2) for key in totals}
        for key in totals:
            totals[key] += scaled[key]
        foods.append({"food_id": food["id"], "name": food["name"], "grams": portion.grams, "nutrition": scaled})
    return foods, {key: round(value, 2) for key, value in totals.items()}
