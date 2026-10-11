# Production prediction pipeline

The development stack invokes the real-time SageMaker endpoint named by the
`modelEndpointName` CDK context value. The current deployment uses
`glucose44-demo-20261011-040922` and model version
`original-adaptive-44-v1`.

## Request path

1. Cognito authorizes `POST /predictions` and the API loads the requested meal
   only from that Cognito subject's DynamoDB partition.
2. The feature adapter loads seven days of that user's earlier meals, Apple
   Health records, profile weight, and uploaded CGM readings.
3. Dexcom sandbox rows are always excluded. Saved-meal predictions require at
   least three participant-uploaded readings in the 15 minutes before the meal.
   Future-meal predictions prefer the participant's uploaded CGM, re-anchoring
   older uploads to the planned meal time when needed. If the account has no
   usable upload, they use the private shared held-out reference stored in S3
   and mark that fallback in the response audit.
4. Saved meal nutrition becomes the endpoint's carbohydrate, protein, fat, and
   fiber input. Prior saved meals become historical meal events.
5. Apple Health heart rate is mapped to the model's HR field. Active-energy and
   workout-energy samples are converted to the model's activity-energy and MET
   fields using the user's saved weight. Zero, missing, invalid, and duplicate
   records are excluded before feature construction. The hosted model does not
   currently consume age, diabetes status, steps, or basal energy directly.
6. The backend sends the resulting timestamped CSV and current meal macros to
   SageMaker. The endpoint returns a five-minute curve through 120 minutes,
   feature sensitivities, a pointwise uncertainty band, quality flags, peak,
   time to peak, and excursion.
7. The API validates the response, recomputes the displayed summary from the
   returned curve, and sends only the user-facing explanation through the
   Amazon Bedrock wellness guardrail.
8. The prediction, input-count audit, sandbox-exclusion flag, model version,
   uncertainty, and guardrail status are stored under the Cognito user ID and
   returned to the web or mobile client.

The frontend renders the complete curve, its uncertainty band, 30/60/90/120
minute points, peak, time to peak, excursion, input counts, model limitations,
and the Bedrock wellness-check status.

## Endpoint contract

```json
{
  "history_csv": "Timestamp,glucose,HR,METs,...",
  "meal_time": "2026-10-10T12:00:00Z",
  "macros": {
    "carbs": 45,
    "protein": 20,
    "fat": 12,
    "fiber": 6
  },
  "guard_minutes": 0,
  "utc_offset_minutes": 0
}
```

The deployed model requires pre-meal glucose context. Apple Health and meal
data supplement that context. The future-meal route can supply the held-out S3
reference when participant CGM is unavailable; it never uses Dexcom sandbox
rows and does not represent the shared reference as the participant's data.
