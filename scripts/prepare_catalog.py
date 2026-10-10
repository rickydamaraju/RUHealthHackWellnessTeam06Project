"""Convert the official FNDDS JSON download to a compact, versioned AWS catalog.

Usage: python scripts/prepare_catalog.py /path/to/USDA-download.zip
Source: https://fdc.nal.usda.gov/download-datasets/
Nutrient amounts in the USDA file are per 100 grams, not per listed portion.
"""
import hashlib
import json
import sys
import zipfile
from pathlib import Path

source = Path(sys.argv[1])
with zipfile.ZipFile(source) as archive:
    raw = json.loads(archive.read(next(n for n in archive.namelist() if n.endswith('.json'))))
foods = []
nutrients = {1003: 'protein_g', 1004: 'fat_g', 1005: 'carbs_g', 1079: 'fiber_g', 1008: 'calories'}
for food in raw['SurveyFoods']:
    values = {nutrients[n['nutrient']['id']]: n['amount'] for n in food.get('foodNutrients', []) if n['nutrient']['id'] in nutrients}
    if len(values) != len(nutrients):
        continue  # Missing nutrients are not zero.
    foods.append({'id': str(food['fdcId']), 'name': food['description'], 'per_100g': values,
                  'portions': [{'label': p['portionDescription'], 'grams': p['gramWeight']} for p in food.get('foodPortions', []) if p.get('gramWeight', 0) > 0][:12]})
out = Path(__file__).resolve().parents[1] / 'backend/app/data/catalog.json'
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(json.dumps({'source': 'USDA FoodData Central FNDDS 2021–2023', 'release': '2024-10-31',
                          'source_sha256': hashlib.sha256(source.read_bytes()).hexdigest(), 'foods': foods}, separators=(',', ':')))
print(f'Prepared {len(foods)} foods with all five nutrients; {out.stat().st_size:,} bytes.')
