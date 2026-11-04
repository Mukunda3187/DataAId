# DataAId — GenAI-powered Cloud Data Quality Platform

DataAId profiles uploaded CSV/XLSX datasets, detects data-quality problems, uses Google Gemini to explain the dataset and detected issues, suggests corrections for human review, and records the correction workflow.

## Main project domains

### Generative AI
- **Dataset Understanding:** Gemini explains what the dataset may contain, describes each column, and provides evidence-based insights from column profiles.
- **AI Issue Explanation:** Gemini explains why a detected issue matters, possible causes, and recommended actions.
- **AI Dataset Assistant:** Users can ask natural-language questions about the dataset profile and detected issue counts.
- **AI Missing-value Suggestions:** Gemini can propose contextual alternatives using column samples and row context.
- **Safe fallback:** Deterministic profile/rule explanations remain available when Gemini is not configured or unavailable. Rule-based findings are not labelled as AI-generated.

### Cloud Computing
- **Render** hosts the Express application and serves the React frontend.
- **Render PostgreSQL** stores analysis jobs as JSONB records when `DATABASE_URL` is configured.
- **Amazon S3** stores uploaded original datasets when AWS credentials and a bucket are configured. Local filesystem / Render Persistent Disk remains the development fallback.
- **Google Gemini API** provides generative AI capabilities through up to three server-side API keys selected round-robin, with retry across the remaining keys for authentication, quota/rate-limit and temporary service errors (the original single-key variable remains supported).
- `/api/status` reports database, file-storage and GenAI status.

## Architecture

```text
Browser (React + TypeScript)
          |
          v
Render Web Service (Express + Node.js)
          |----------------------|----------------------|
          v                      v                      v
Google Gemini API          PostgreSQL          Amazon S3
(dataset understanding,    (analysis jobs,      (original uploads,
issue explanations,         corrections,         corrected exports)
dataset Q&A)                history)
```

### Datamate data retrieval examples

Datamate supports deterministic extraction from the active dataset:
- `show row 15` — returns the 15th data row (the header is not counted).
- `give me the Name and Age columns` — returns only those columns.
- `show rows where City = Hyderabad` — filters actual rows using the requested condition.
- `create a dataset with Name, Age and Salary where Age > 25` — combines column selection and filtering.

The backend validates requested column names against the dataset and applies row selection, filters and column projection to the actual parsed rows. Gemini interprets natural-language requests; it does not fabricate the returned records.

The application uses deterministic profiling and data-quality rules for measurable checks. Gemini is used for natural-language understanding and recommendations, not as a replacement for deterministic validation. Datamate can return exact row-number selections, selected columns, and filtered dataset subsets; the actual rows are selected by the backend from the uploaded dataset. AI recommendations should be reviewed before applying corrections.

## Run locally

Requirements: Node.js 22.12 or later and npm.

```bash
npm install
cp .env.example .env
npm run dev
```

Open `http://localhost:3000`.

Locally, uploaded source files are stored in `./uploads` by default. The application uses `persistent_database.json` when `DATABASE_URL` is not configured. Local files and JSON persistence are for development only.

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `GEMINI_API_KEY_1` | For live AI | First Gemini API key; keep it server-side (keys are tried round-robin with retry) |
| `GEMINI_API_KEY_2` | No | Optional second Gemini key for round-robin selection |
| `GEMINI_API_KEY_3` | No | Optional third Gemini key for round-robin selection |
| `GEMINI_API_KEY` | No | Backward-compatible single-key option |
| `GEMINI_MODEL` | No | Model name; defaults to `gemini-2.5-flash` |
| `DATABASE_URL` | For cloud DB | PostgreSQL connection string |
| `DATABASE_SSL` | No | Defaults to SSL enabled for cloud PostgreSQL |
| `AWS_REGION` | No | AWS region, defaults to `ap-south-1` |
| `AWS_S3_BUCKET` | No | Private S3 bucket name; enables S3 storage when credentials are set |
| `AWS_ACCESS_KEY_ID` | No | IAM access key for the backend |
| `AWS_SECRET_ACCESS_KEY` | No | IAM secret key; never commit it |
| `DATA_STORAGE_DIR` | No | Local / Render disk fallback directory |
| `PORT` | No | Server port; Render supplies this automatically |
| `NODE_ENV` | No | Set to `production` on Render |

## Deploy to Render

1. Push this project to a GitHub repository.
2. In Render, choose **New → Blueprint** and select the repository containing `render.yaml`.
3. Review the web-service and PostgreSQL plans and their current pricing before creating them.
4. The Blueprint attaches a 1 GB persistent disk at `/var/data` and sets `DATA_STORAGE_DIR=/var/data/dataaid-uploads`.
5. Add `GEMINI_API_KEY_1` (and optionally `_2` and `_3`) in the Render service's Environment settings.
6. Add `AWS_REGION`, `AWS_S3_BUCKET`, `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` to enable S3. If these are not configured, the app uses its local / Render disk fallback.
7. Deploy. Visit `/api/status` on the deployed URL. Confirm `databaseConnected: true`, `storage: "postgresql"`, `fileStorage.provider: "Amazon S3" when S3 is configured (otherwise the Render disk fallback)`, and `genAiConnected: true`.
8. Upload a small test CSV, open Report → Dataset Understanding, ask the AI assistant a question, approve one correction, and confirm the analysis remains available after a redeploy.

**Render disk limitation:** A persistent disk is attached to one service instance. It is suitable for a single-instance student project, but it is not shared storage for multiple instances and can limit zero-downtime deployments and horizontal scaling. Check Render's current disk pricing and service-plan requirements.

## Build and production start

```bash
npm install
npm run build
npm start
```

The build creates the React assets in `dist/` and bundles the Express server into `dist-server/server.js`.

## Important limitations

- Original uploaded files are stored in Amazon S3 when all AWS settings are present. Otherwise, local development uses the filesystem and Render uses the attached persistent disk.
- The current analysis record (including parsed rows and correction state) is stored as a PostgreSQL JSONB document. This is appropriate for a student project/demo but should be normalized for very large datasets or high concurrency.
- Dataset profiling and correction are currently performed in the web request. A production-scale version should move large jobs to a dedicated background worker and queue.
- The AI assistant receives column profiles, small samples and issue counts, not every raw row. It must say when this context is insufficient rather than inventing exact row-level answers.
- No authentication or per-user authorization layer is included yet. Do not expose sensitive or personal datasets publicly until authentication, authorization, retention and access controls are implemented.

## Security notes

- Never commit `.env` or API keys.
- Keep `GEMINI_API_KEY` on the server; never expose it in frontend code.
- Keep the Render service and database access restricted as appropriate.
- Uploaded datasets may contain personal or sensitive information. Implement authentication, authorization and retention controls before using real customer data.


## AWS S3 setup

1. Create a private S3 bucket in your chosen AWS region (Mumbai: `ap-south-1` is the default).
2. Keep Block Public Access enabled and use S3-managed encryption (SSE-S3).
3. Create an IAM identity restricted to that bucket with `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject` on `bucket-name/*` and `s3:ListBucket` on the bucket ARN.
4. Set `AWS_REGION`, `AWS_S3_BUCKET`, `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` in `.env` locally and in Render Environment settings.
5. Install dependencies with `npm install` after pulling the AWS integration (the AWS SDK v3 S3 client is a project dependency).

When S3 is configured, uploads go to S3. If it is not configured, local development uses `./uploads` and Render can use its attached persistent disk. Do not commit `.env`, AWS credentials, or Gemini keys.
