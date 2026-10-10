# Glucose Compass — Predict My Glucose Response

Glucose Compass is an AWS-hosted wellness research prototype for participant sign-in, searchable meal and photo logging, CGM CSV uploads, and future person-specific glucose prediction. It deliberately avoids diagnostic or medication claims.

## What is implemented

- Responsive React + TypeScript website, ready to share its typed API client with a later React Native app
- Amazon Cognito hosted sign-in and registration; passwords are handled by Cognito and are never stored by this application
- Amazon API Gateway HTTP API with Cognito JWT authorization on participant routes
- FastAPI services on AWS Lambda for food search, meal records, uploads, and prediction orchestration
- Private, encrypted Amazon S3 buckets behind CloudFront for the website, raw CGM files, prepared data, and model artifacts
- DynamoDB participant partitions for meals, CGM readings, imports, and predictions
- S3 event → SQS → Lambda processing for validated, retry-safe CGM imports
- USDA FNDDS 2021–2023 catalog with 5,431 foods and confirmed portion-based nutrition
- Mobile camera and image upload for meal photos, stored privately in the participant's S3 path; Amazon Nova Lite identifies visible foods and portions, then the app calculates editable nutrition estimates from USDA data
- Amazon Bedrock for optional meal-text extraction and a Guardrail that blocks diagnosis and medication-dosing language
- A SageMaker model endpoint adapter with validated prediction and uncertainty contracts
- AWS CDK infrastructure and an optional GitHub-to-CodePipeline deployment stack

## System flow

```text
Browser / future mobile app
  ├─ Cognito Hosted UI (registration, login, tokens)
  └─ CloudFront → private S3 website
                  ↓ JWT
             API Gateway → FastAPI Lambda
                  ├─ DynamoDB (meals, readings, predictions)
                  ├─ S3 upload → SQS → import Lambda
                  ├─ Bedrock text extraction + wellness guardrail
                  └─ SageMaker endpoint (team model, connected later)
```

S3 stores files and model artifacts. Cognito stores login credentials. DynamoDB stores structured participant records. Every participant-owned record uses the verified Cognito subject from API Gateway; the browser cannot choose another participant ID.

## Local preview

Requirements: Node.js 22+, npm, and Python 3.12.

```bash
npm ci
python3.12 -m venv .venv
.venv/bin/pip install -r backend/requirements-dev.txt
npm run dev
```

Open `http://localhost:5173`. Before AWS deployment, choose **Explore the workspace**. Preview entries remain only in the browser session; sign-in and cloud uploads require the deployed stack.

Validate before a merge:

```bash
npm run check
npm run test:backend
npm run build
npm run synth -- --quiet
```

## First AWS deployment

Use a temporary hackathon role or AWS IAM Identity Center profile. Do not commit access keys. You need AWS CLI v2, Docker, and permission to create the services listed above.

```bash
aws sso login --profile YOUR_PROFILE
export AWS_PROFILE=YOUR_PROFILE
export CDK_DEFAULT_REGION=us-east-1
npx cdk bootstrap
npm run build
npm run deploy -- -c stage=dev --require-approval never
```

The deployment outputs `WebsiteUrl`, `ApiUrl`, `UserPoolId`, `ClientId`, `DataBucket`, and `ModelBucket`. Open `WebsiteUrl`, create an account, confirm the email, sign in, search a food, log a meal, and upload `frontend/public/cgm-template.csv`.

To enable natural-language meal extraction and meal-photo analysis, deploy with an image-capable Bedrock model such as `-c bedrockModelId=amazon.nova-lite-v1:0`. Food search and structured meal logging work without it. To attach the team model, follow [docs/MODEL_INTEGRATION.md](docs/MODEL_INTEGRATION.md).

## Team workflow and deployment pipeline

Protect `main` in GitHub: require pull requests, at least one approval, and the validation commands above. Each teammate should branch from `main`, make one focused change, open a PR, and merge only after checks pass.

For automatic AWS deployments, create an AWS CodeConnections GitHub connection, then deploy the optional pipeline:

```bash
npm run deploy -- -c stage=dev -c connectionArn=YOUR_CODECONNECTIONS_ARN --require-approval never
```

The pipeline watches `rickydamaraju/RUHealthHackWellnessTeam06Project` on `main`, validates the project, builds the website and Lambda images, then deploys with CDK. The connection must be confirmed in the AWS console once.

## V1 data and safety boundaries

- Accepted CGM file: UTF-8 CSV with `timestamp,glucose`, timezone-aware ISO 8601 timestamps, one selected unit, at most 10 MB and 20,000 readings
- Meal nutrition is an estimate derived from the participant-confirmed USDA item and gram amount
- Prediction is unavailable until a real model endpoint is configured; no synthetic prediction is shown as participant data
- Bedrock Guardrails screen explanatory wording. Numeric model outputs are preserved and model/schema failures return a clear unavailable response
- This is a hackathon research prototype, not a HIPAA production system. Before real clinical use, complete legal/security review, consent and retention design, audit controls, monitoring, incident response, accessibility testing, and a formal model validation plan

## Repository layout

```text
frontend/              React website
backend/app/           FastAPI API and CGM worker
backend/tests/         data/auth/model-contract checks
infrastructure/        AWS CDK stacks
packages/contracts/    shared web/mobile types
packages/api-client/   browser-independent API client
scripts/               USDA catalog preparation
docs/                  model handoff contract
```
