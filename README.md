# ClipForge — AI vertical clip generator (Version 1)

Turn one long video into short vertical (9:16) clips with AI-picked moments and burned-in captions.
Cloud-only: the only thing you need on your OPPO AK1 is a browser.

**V1 success criterion:** upload one video → transcribe it → AI picks strong moments → FFmpeg cuts
vertical clips with captions → preview and download each clip.

---

## 1. Architecture

A single Next.js (App Router) deployment holds the UI, the API and the worker. Job state lives in
PostgreSQL so progress survives page reloads and server restarts.

```
Browser (mobile web)                Next.js server (Node runtime)              External
─────────────────────              ─────────────────────────────              ────────
page.tsx  ──POST /api/jobs/upload──▶ ingest.ts ──stream to disk──▶ storage.ts
          ──POST /api/jobs (url) ──▶            └─yt-dlp optional─┘
          ──GET  /api/jobs/:id ───▶ jobs.ts (queue, 1 worker) ──▶ pipeline.ts
                                             │
                                             ├─▶ ffmpeg.ts      probe + extract 16k mono FLAC + render
                                             ├─▶ transcribe.ts  Groq Whisper (chunked, word timestamps)
                                             ├─▶ analyze.ts     Groq → OpenRouter fallback, strict JSON
                                             ├─▶ validate.ts    clamp / snap / de-overlap timestamps
                                             ├─▶ subtitles.ts   word timings → karaoke ASS
                                             └─▶ render.ts path crop→9:16→burn captions (one pass)
                                             │
                                             └─▶ Postgres (jobs, clips, job_events) + temp disk
```

### Module boundaries (one responsibility each)

| File | Responsibility |
| --- | --- |
| `src/app/page.tsx` | Mobile-first UI: source picker, options, progress, clip list |
| `src/app/api/*` | Thin HTTP layer: create/poll/delete jobs, stream clips, cleanup, diagnostics |
| `src/lib/jobs.ts` | Job manager: queue, concurrency limit, restart recovery, cleanup scheduler |
| `src/lib/pipeline.ts` | Orchestrates all stages, persists progress + errors |
| `src/lib/ingest.ts` | Streamed uploads, direct-URL download, source validation |
| `src/lib/ffmpeg.ts` | Only place that spawns FFmpeg/FFprobe |
| `src/lib/transcribe.ts` | Audio extraction + Groq Whisper with chunking and overlap merging |
| `src/lib/analyze.ts` | Prompt building, provider failover, JSON extraction |
| `src/lib/validate.ts` | Timestamp validation, snapping to speech, overlap removal |
| `src/lib/subtitles.ts` | Caption grouping and ASS/SRT generation |
| `src/lib/storage.ts` | Temp dirs, disk-space guard, retention purge |
| `src/db/schema.ts` | `jobs`, `clips`, `job_events` |

### Pipeline stages (persisted, pollable)

`queued → ingesting → probing → extracting_audio → transcribing → analyzing → selecting → rendering → finalizing → done`

Weights drive a 0–100 progress bar; `job_events` keeps the full log so nothing fails silently.

---

## 2. API

| Method | Route | Purpose |
| --- | --- | --- |
| `POST` | `/api/jobs` | Create a job from a direct media URL |
| `POST` | `/api/jobs/upload` | Create a job from a raw binary upload body (streams to disk) |
| `GET` | `/api/jobs` | Recent jobs |
| `GET` | `/api/jobs/:id` | Full job state: stage, progress, clips, events, transcript preview |
| `DELETE` | `/api/jobs/:id` | Delete job + clips + temp files immediately |
| `POST` | `/api/jobs/:id/retry` | Re-run a failed/partial job |
| `GET` | `/api/clips/:id/file` | Stream a clip (HTTP Range supported, `?download=1` to force download) |
| `GET` | `/api/diagnostics/render` | Renders a real 4s clip to prove FFmpeg + fonts work on this host |
| `POST` | `/api/maintenance/cleanup` | Purge expired jobs (also on an in-process timer) |
| `GET` | `/api/health`, `/api/config` | Health, provider status, limits |

Example:

```bash
curl -X POST https://your-host/api/jobs/upload?clips=3 \
  -H "x-file-name: interview.mp4" \
  --data-binary @interview.mp4
```

---

## 3. Setup

```bash
cp .env.example .env      # then fill in DATABASE_URL + GROQ_API_KEY
npm install
npx drizzle-kit push      # creates jobs / clips / job_events
npm run build && npm start
```

FFmpeg is bundled via `ffmpeg-static` / `ffprobe-static`, so **no system FFmpeg install is required**.
If you prefer a system build, set `FFMPEG_PATH` / `FFPROBE_PATH`.

Verify a deployment from your phone: open the app → *Server health & FFmpeg self-test* → **Run FFmpeg
self-test**. It renders a real 4-second 1080×1920 clip with a burned caption and reports every step.

---

## 4. Deployment (the honest version)

Because FFmpeg, local disk and long jobs are involved, **you need a long-running Node server with a
writable disk** — not a serverless function.

| Option | Works? | Notes |
| --- | --- | --- |
| Railway / Render / Fly.io (Node service) | ✅ recommended | ~$5/mo, persistent disk, apt not required (bundled FFmpeg) |
| Hetzner / DigitalOcean VPS (Node + Postgres) | ✅ cheapest | 1 vCPU / 2GB is enough at `MAX_CONCURRENT_JOBS=1` |
| Vercel serverless | ❌ for processing | 10–60s limits, ephemeral FS, no long jobs. You *can* host the UI there and point it at a separate worker, but that split is **not built in V1** |
| Netlify / static-only | ❌ | No Node runtime for FFmpeg |

**Cheap setup that works today:** one Railway/Render Node service + its Postgres add-on. Attach a
persistent mount and set `STORAGE_DIR` to it — otherwise clips vanish on redeploy (see limits below).

**Free cron (optional):** point cron-job.org at `POST /api/maintenance/cleanup` every 15 min. The
in-process scheduler already runs it, so this is belt-and-braces.

---

## 5. Known limits in Version 1 (by design, not bugs)

- **Social platform links (YouTube, TikTok, Instagram, Vimeo) are not supported.** They need
  `yt-dlp`, which is a Python scraping tool that breaks regularly and is not installable on most
  managed Node hosts. Paste a **direct media URL** (`.mp4`/`.mov`/`.webm`) or upload the file from
  your phone. `ALLOW_YTDLP=1` enables it *only* on a host where the binary is genuinely installed —
  the app detects it at runtime and never pretends otherwise.
- **Center crop only.** No face tracking or subject reframing. A speaker who walks off-centre will
  drift out of frame.
- **No accounts, no multi-tenancy.** Anyone with the URL can use the server and see its clips. Do not
  expose it publicly.
- **Temp storage only.** Jobs are deleted after `RETENTION_HOURS` (default 6). Without a persistent
  disk, clips are also lost on redeploy or instance restart. Download clips you want to keep.
- **Single worker** (`MAX_CONCURRENT_JOBS=1`). A second job waits in the queue; the UI shows "Queued".
- **Restart semantics.** If the process dies mid-job, startup marks it failed with
  *"Interrupted by a server restart"* — or re-queues it if the source file is still on disk. It never
  reports success for work that did not finish.
- **Groq 25MB transcription cap** is handled by chunking audio (default 600s chunks with 1.5s overlap
  and de-duplication), so hour-long videos work.
- **Vertical output is fixed** at 1080×1920 / 30fps / CRF 23 (env-tunable). Sources below ~1080p are
  upscaled to fill the frame.

---

## 6. Error handling

Every failure is classified (`kind`), shown in the UI, and stored on the job row:

| `kind` | Meaning | What the UI says |
| --- | --- | --- |
| `missing_api_key` | Provider key absent/rejected | Fix the env var |
| `unsupported_media` | Corrupt, too short, no audio, dead codec | Re-encode / try another file |
| `too_large` | Upload, duration or provider size limit | Trim or raise the limit |
| `download_failed` | URL unreachable, non-media, timeout | Check the link |
| `transcription_failed` | Groq failed after retries, or no speech | Retry / check audio |
| `invalid_ai_output` | Unparseable or empty model JSON | Includes the raw response snippet |
| `rate_limited` | HTTP 429 | Auto-retries with backoff, then falls back to OpenRouter |
| `ffmpeg_error` | Non-zero exit, timeout, empty output | Last 8 lines of FFmpeg stderr are kept |
| `disk_full` | Below `MIN_FREE_DISK_MB` | Free space / lower retention |
| `interrupted` | Server restarted mid-job | Run the job again |

Partial success is supported: if clip 2 of 3 fails to render, clips 1 and 3 are still delivered and
the job ends as `partial` with the per-clip error visible.
