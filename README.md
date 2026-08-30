# ClipForge — AI vertical clip generator

ClipForge turns a long video into captioned 9:16 clips. The existing mobile UI, upload/URL ingest, Groq transcription, AI selection, FFmpeg rendering, retries, progress polling, and downloads run in one long-running Next.js application.

## Production architecture

```text
Browser ──HTTPS──> Render web service (Next.js UI + API + one in-process worker)
                         ├── PostgreSQL: jobs, progress, transcript, metadata
                         ├── Cloudflare R2: source videos, clips, poster frames
                         ├── Gemini: direct long-transcript analysis
                         ├── OpenRouter: analysis fallback
                         ├── Groq: Whisper transcription + smaller analysis fallback
                         └── /tmp/clipforge: active-job scratch files only
                                      └── FFmpeg/FFprobe installed in Docker
```

This application must **not** be deployed to Vercel/serverless. FFmpeg jobs can take many minutes and require a stable process, CPU, and temporary disk. Render is configured as a Docker web service. Keep the service at **one instance** in V2 because its queue is in-process; `MAX_CONCURRENT_JOBS=1` is recommended on a small machine.

### Storage lifecycle

* Browser uploads stream directly into the private R2 bucket; they are not retained on app disk.
* A worker downloads the source from R2 into its job scratch directory immediately before processing.
* Direct public video URLs are acquired through the source-provider layer directly into the active job's scratch directory. They are not retained in R2 unless `PERSIST_URL_SOURCES=true`.
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

No R2 CORS rule is required for V2 because browsers communicate with the same-origin API, not R2 directly.

### 2. Render PostgreSQL

Create a managed Render PostgreSQL database. Use its **internal** connection URL as `DATABASE_URL` when the app and database are in the same Render region. The included `render.yaml` can create and wire this database automatically.

### 3. Render web service

1. Push this repository/branch to GitHub.
2. Render Dashboard → **New → Blueprint** and select the repository (uses `render.yaml`), or create a **Web Service** with runtime **Docker**.
3. Choose a paid, always-on instance with at least **2 GB RAM** and enough CPU for FFmpeg. Do not configure autoscaling or multiple instances for V2.
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
| `GROQ_API_KEY` | Groq key for Whisper transcription and analysis fallback |
| `GEMINI_API_KEY` | Google AI Studio key for direct Gemini analysis (preferred for long videos) |
| `GEMINI_TEXT_MODEL` | A Gemini model ID currently available to that API account |
| `OPENROUTER_API_KEY` | OpenRouter analysis fallback key (optional) |
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
MAX_URL_REDIRECTS=5
PERSIST_URL_SOURCES=false
MAX_MUSIC_UPLOAD_MB=50
MAX_MUSIC_DURATION_MINUTES=30
OUTPUT_SQUARE_SIZE=1080
OUTPUT_LANDSCAPE_WIDTH=1920
OUTPUT_LANDSCAPE_HEIGHT=1080
```

See `.env.example` for every tuning variable. Secrets are only read by server modules and are not returned by `/api/config` or embedded in frontend code.

### AI analysis configuration

The analysis model is separate from Whisper transcription. Direct Google Gemini is preferred, followed by OpenRouter and then Groq. Gemini model availability differs by API account, so `GEMINI_TEXT_MODEL` is required and must be set to a model actually listed for that account; the example below is not assumed valid by the application. A model 404 or OpenRouter credit 402 disables that provider for the rest of the current job and immediately continues fallback.

```env
GEMINI_API_KEY=
GEMINI_TEXT_MODEL=gemini-3.6-flash # verify against your Google account
GROQ_TEXT_MODEL=openai/gpt-oss-20b
OPENROUTER_TEXT_MODEL=google/gemini-2.5-flash
ANALYSIS_PROVIDERS=gemini,openrouter,groq
ANALYSIS_MAX_RETRIES=1
ANALYSIS_MAX_INPUT_TOKENS=4500
ANALYSIS_PROMPT_RESERVE_TOKENS=1000
ANALYSIS_DISCOVERY_OUTPUT_TOKENS=1200
ANALYSIS_SELECTION_OUTPUT_TOKENS=700
ANALYSIS_GROQ_TOTAL_TOKENS=6500
ANALYSIS_TRANSCRIPT_MAX_CHARS=12000
ANALYSIS_CHUNK_MAX_SECONDS=600
ANALYSIS_CHUNK_OVERLAP_SEC=30
ANALYSIS_GROQ_SAFE_CHARS=14000
```

Timestamped transcript segments are split primarily by a conservative token estimate, with character/time limits as secondary guards and a small duration-aware overlap. The default 4,500-token input ceiling reserves 1,000 tokens for instructions, leaving roughly 3,500 estimated transcript tokens per discovery part. Discovery runs independently on every part; long videos then receive a compact global candidate-ranking pass. Output is capped at 1,200 tokens for discovery and 700 for ranking instead of 4,096.

The backend trims overlong descriptive fields, repairs common JSON wrappers, validates real segment indexes/timestamps, removes overlap, and selects final clips globally. Groq is excluded before a request would exceed its conservative total budget; an unexpected Groq 413 receives one retry using a much smaller segment-boundary section. HTTP 429 honors `Retry-After` with bounded exponential backoff. Failed parts do not discard candidates from successful parts, and the job fails analysis only when no usable candidates survive. Video data is never sent to an analysis model.

## Database migrations

SQL migrations live in `drizzle/`. `scripts/migrate.mjs` uses `DATABASE_URL` and records applied filenames in `clipforge_migrations`. Migrations are transactional and idempotent, so every Render start can safely run:

```bash
npm run db:migrate
```

For schema development, set `DATABASE_URL` locally and run `npm run db:generate`. There are no hardcoded PostgreSQL hosts, users, passwords, or database names in application/Drizzle configuration.

## Job reliability and errors

Job state and events are persisted in PostgreSQL. At startup, queued jobs are restored. Interrupted URL jobs are downloaded again, and interrupted uploads restart from their durable R2 source. Every pipeline exit cleans scratch files. Failed provider, R2, PostgreSQL, disk, and FFmpeg operations produce explicit job/health diagnostics rather than silent failures.

The V2 queue is intentionally in the web process. Render must remain a single long-running instance. A future multi-instance deployment should move queue claiming to PostgreSQL or a dedicated queue/worker service.

## Modular URL and media flow

1. The API parses the URL, permits only HTTP/HTTPS without embedded credentials, resolves DNS, and rejects loopback, private, link-local, reserved, and internal hostnames.
2. The `VideoSourceAdapter` registry detects direct media, public Dropbox shares, and public Google Drive file shares. Known social/webpage providers are rejected with provider-specific guidance; webpage HTML is never passed to FFmpeg.
3. Dropbox and Drive adapters resolve only their authorized public file-link forms. The resulting download URL and every manual redirect receive the same DNS/IP SSRF validation.
4. Content type and size are checked before streaming. A transform enforces `MAX_URL_SIZE_MB` even without Content-Length, and an abort timer enforces `URL_DOWNLOAD_TIMEOUT_SEC`.
5. Every adapter returns one normalized local file to the shared probe → transcription → analysis → validation → render pipeline.
6. The pipeline `finally` block removes the entire job scratch directory after success or failure. Only configured retained sources and final clips/posters remain in R2.

New authorized source adapters can be added to `src/lib/video-source.ts` without changing downstream processing.

## Output formats and optional music

Output format is selected before job creation and persisted on the job. Vertical and square outputs use aspect-preserving center crop; landscape uses aspect-preserving fit and padding, so video is never stretched. Dimensions are configurable with `TARGET_WIDTH`, `TARGET_HEIGHT`, `OUTPUT_SQUARE_SIZE`, `OUTPUT_LANDSCAPE_WIDTH`, and `OUTPUT_LANDSCAPE_HEIGHT`.

## Persistent Media Library

The `/media-library` page stores reusable background music and sound effects in the existing private R2 bucket. Each asset gets a permanent database record with its display name, original filename/type, size, tags, object key, and optional duration/analysis metadata. Upload requests only stream bytes to R2 and save the database record; they do not download the object again or run blocking FFprobe/FFmpeg work. Duration and analysis may therefore be unknown, while clip jobs reuse the available tags/metadata and store only asset IDs through `job_media_assets`.

Clip creation supports no added audio, manual music selection, or metadata-only auto-match against the AI-selected clip title/hook/reason. Auto-match may use a chosen candidate pool or the full music library. Selected sound effects rotate across clips. The worker downloads only assets actually chosen for rendered clips into the active job scratch directory and removes them in the existing pipeline cleanup.

Rendering starts music near saved energy peaks when feasible, loops/trims and fades it, ducks it under speech with sidechain compression, mixes optional effects, and applies a limiter. If added-audio mixing is unsupported by the host FFmpeg build, that clip is retried without added audio; jobs with no selected media use the unchanged rendering path. Library assets remain in R2 until explicitly deleted, and deletion is blocked while an active job references the asset.
