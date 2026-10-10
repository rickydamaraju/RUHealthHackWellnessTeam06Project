# Model integration contract

The application does not contain a glucose model. It exposes a stable boundary so the modeling team can deploy any compatible container behind an Amazon SageMaker real-time endpoint.

## Request sent to SageMaker

The API sends `application/json` with this structure:

```json
{
  "schema_version": "1.0",
  "meal": {
    "id": "uuid",
    "eaten_at": "2026-10-10T16:30:00Z",
    "description": "lunch",
    "nutrition": { "carbs_g": 42, "protein_g": 20, "fat_g": 9, "fiber_g": 5, "calories": 330 },
    "foods": []
  },
  "cgm_history": [{ "timestamp": "2026-10-10T16:25:00Z", "glucose_mg_dl": 104 }],
  "heart_rate": [],
  "medications": []
}
```

`cgm_history` contains at most 2,016 readings up to the meal time, in chronological order. The empty multimodal arrays are reserved so heart-rate and medication support can be added without changing the top-level contract.

## Response required from SageMaker

```json
{
  "model_version": "participant-model-2026-10-10",
  "baseline_mg_dl": 104,
  "curve": [
    { "minutes": 30, "glucose_mg_dl": 126 },
    { "minutes": 60, "glucose_mg_dl": 142 },
    { "minutes": 90, "glucose_mg_dl": 132 },
    { "minutes": 120, "glucose_mg_dl": 116 }
  ],
  "feature_contributions": [
    { "feature": "carbs_g", "importance": 0.61 },
    { "feature": "baseline_mg_dl", "importance": 0.22 }
  ],
  "uncertainty": { "method": "bootstrap", "lower_mg_dl": [115, 128, 119, 106], "upper_mg_dl": [137, 156, 145, 126] },
  "quality_flags": []
}
```

The API rejects a response unless it contains exactly the 30, 60, 90, and 120-minute horizons. It computes peak, time-to-peak, and excursion itself, screens the wellness explanation with Bedrock Guardrails, and stores the result in the authenticated participant's DynamoDB partition.

Connect an existing endpoint during deployment:

```bash
npm run deploy -- -c stage=dev -c modelEndpointName=YOUR_ENDPOINT_NAME
```

The CDK stack grants the API permission to invoke only that endpoint. Rebuild and redeploy if the endpoint name changes.
