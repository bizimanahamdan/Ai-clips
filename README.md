# ClipForge — AI vertical clip generator

ClipForge turns a long video into captioned 9:16 clips. The existing mobile UI, upload/URL ingest, Groq transcription, AI selection, FFmpeg rendering, retries, progress polling, and downloads run in one long-running Next.js application.

## Production architecture

```text
Browser ──HTTPS──> Render web service (Next.js UI + API + one in-process worker)
                         ├── PostgreSQL: jobs, progress, transcript, metadata
                         ├── Cloudflare R2: source videos, clips, poster frames
                         ├── Groq: Whisper transcription + primary analysis
                         ├── OpenRouter: optional analysis fallback
                         └── /tmp/clipforge: active-job scratch files only
                                      └── FFmpeg/FFprobe installed in Docker
```

This application must **not** be deployed to Vercel/serverless. FFmpeg jobs can take many minutes and require a stable process, CPU, and temporary disk. Render is configured as a Docker web service. Keep the service at **one instance** in V1 because its queue is in-process; `MAX_CONCURRENT_JOBS=1` is recommended on a small machine.

### Storage lifecycle

* Browser uploads stream directly into the private R2 bucket; they are not retained on app disk.
* A worker downloads the source from R2 into its job scratch directory immediately before processing.
* Direct-URL sources are downloaded to scratch and copied to R2 before processing continues.
* Each rendered clip and poster is uploaded to R2 immediately, then its local copy is deleted.
* The entire scratch directory and local source are removed in the pipeline `finally` block on success or failure.
* The existing retention cleanup deletes expired database rows and their R2 source/clip/poster objects. Set `RETENTION_HOURS` to the desired product retention period.
* Clip playback/download keeps the existing same-origin API URL. The API streams the private R2 object and supports HTTP Range requests.

## Local development

Prerequisites: Node.js 22, PostgreSQL, FFmpeg/FFprobe on `PATH`, and an R2 bucket/token.

```bash
cp .env.example .env
# Fill all required values
npm ci
npm run db:migrate
npm run dev
```

`npm run build` intentionally works without `DATABASE_URL`; database initialization is lazy at runtime. `npm start` first runs all checked-in SQL migrations and only starts Next.js if migration succeeds.

Useful checks:

```bash
npm run typecheck
npm run lint
npm run build
curl http://localhost:3000/api/health
```

The health endpoint tests PostgreSQL, R2 bucket access, FFmpeg/FFprobe, provider configuration, temporary storage, and queue startup. The UI's FFmpeg self-test remains available.

## Exact Render deployment

### 1. Cloudflare R2

1. Keep/create the bucket **`my-clips-storage`**.
2. In Cloudflare, create an R2 API token scoped to that bucket with **Object Read & Write** permission.
3. Record the Account ID, Access Key ID, and Secret Access Key.
4. The S3 endpoint is normally `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`. Do not use the public `r2.dev` URL. The bucket can remain private.

No R2 CORS rule is required for V1 because browsers communicate with the same-origin API, not R2 directly.

### 2. Render PostgreSQL

Create a managed Render PostgreSQL database. Use its **internal** connection URL as `DATABASE_URL` when the app and database are in the same Render region. The included `render.yaml` can create and wire this database automatically.

### 3. Render web service

1. Push this repository/branch to GitHub.
2. Render Dashboard → **New → Blueprint** and select the repository (uses `render.yaml`), or create a **Web Service** with runtime **Docker**.
3. Choose a paid, always-on instance with at least **2 GB RAM** and enough CPU for FFmpeg. Do not configure autoscaling or multiple instances for V1.
4. Add all secret environment variables listed below. Set `FRONTEND_URL` to the final `https://...onrender.com` URL.
5. Deploy. Docker installs FFmpeg, Next.js builds, `npm start` runs migrations, then binds Next.js to `0.0.0.0:$PORT`.
6. Open `/api/health`; confirm database, R2, FFmpeg, providers, and queue report ready.
7. In the UI, run the FFmpeg self-test, then submit a short real video.

A Render persistent disk is **not needed**: `/tmp/clipforge` is disposable processing scratch space. Ensure the instance has enough ephemeral disk for one source, extracted audio, and one output clip.

## Environment variables

Required on the Render web service (all are server-only; never prefix them with `NEXT_PUBLIC_`):

| Variable | Value |
|---|---|
| `DATABASE_URL` | Render PostgreSQL internal connection URL |
| `GROQ_API_KEY` | Groq key for Whisper and primary analysis |
| `OPENROUTER_API_KEY` | OpenRouter fallback key (may be blank if fallback is intentionally disabled) |
| `R2_ACCOUNT_ID` | Cloudflare account ID |
| `R2_ACCESS_KEY_ID` | R2 token access key ID |
| `R2_SECRET_ACCESS_KEY` | R2 token secret |
| `R2_BUCKET_NAME` | `my-clips-storage` |
| `R2_ENDPOINT` | `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` |
| `FRONTEND_URL` | Public Render application origin, no trailing slash |

Recommended production settings:

```env
STORAGE_DIR=/tmp/clipforge
MAX_CONCURRENT_JOBS=1
RETENTION_HOURS=24
ALLOW_YTDLP=false
```

See `.env.example` for every tuning variable. Secrets are only read by server modules and are not returned by `/api/config` or embedded in frontend code.

### AI analysis configuration

The analysis model is separate from the Whisper model. `GROQ_TRANSCRIBE_MODEL` controls transcription; `GROQ_TEXT_MODEL` and `OPENROUTER_TEXT_MODEL` control clip selection. The default analysis order is `groq,openrouter`. A provider receives one strict structured-output request and, only when correction is useful, one corrected JSON-mode retry before the next configured provider is used.

```env
GROQ_TEXT_MODEL=openai/gpt-oss-20b
OPENROUTER_TEXT_MODEL=google/gemini-2.5-flash
ANALYSIS_PROVIDERS=groq,openrouter
ANALYSIS_MAX_RETRIES=1
ANALYSIS_CANDIDATE_MULTIPLIER=3
ANALYSIS_TRANSCRIPT_MAX_CHARS=90000
```

The model selects indexed transcript segments rather than inventing timestamps. Timestamp output remains accepted as a compatibility fallback, including clock strings such as `01:55.5`. The backend validates, ranks, and removes overlap before rendering. Video data is never loaded into the analysis prompt.

## Database migrations

SQL migrations live in `drizzle/`. `scripts/migrate.mjs` uses `DATABASE_URL` and records applied filenames in `clipforge_migrations`. Migrations are transactional and idempotent, so every Render start can safely run:

```bash
npm run db:migrate
```

For schema development, set `DATABASE_URL` locally and run `npm run db:generate`. There are no hardcoded PostgreSQL hosts, users, passwords, or database names in application/Drizzle configuration.

## Job reliability and errors

Job state and events are persisted in PostgreSQL. At startup, queued jobs are restored. Interrupted URL jobs are downloaded again, and interrupted uploads restart from their durable R2 source. Every pipeline exit cleans scratch files. Failed provider, R2, PostgreSQL, disk, and FFmpeg operations produce explicit job/health diagnostics rather than silent failures.

The V1 queue is intentionally in the web process. Render must remain a single long-running instance. A future multi-instance deployment should move queue claiming to PostgreSQL or a dedicated queue/worker service; that split is not necessary for this reliable V1 architecture.
