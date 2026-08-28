import os from "node:os";
import path from "node:path";

/**
 * All runtime tuning lives here. Everything is env-overridable so the same
 * build runs on a tiny cheap cloud box or a bigger one without code changes.
 */
function num(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function str(key: string, fallback: string): string {
  const raw = process.env[key];
  return raw && raw.trim() ? raw.trim() : fallback;
}

function bool(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

export const config = {
  /** Storage -------------------------------------------------------------- */
  storageDir:
    process.env.STORAGE_DIR && process.env.STORAGE_DIR.trim()
      ? process.env.STORAGE_DIR.trim()
      : path.join(os.tmpdir(), "clipforge"),
  /** Database records and R2 objects are deleted after this many hours. */
  retentionHours: num("RETENTION_HOURS", 24),

  /** Cloudflare R2 (all values remain server-only). */
  r2AccountId: process.env.R2_ACCOUNT_ID?.trim() || "",
  r2AccessKeyId: process.env.R2_ACCESS_KEY_ID?.trim() || "",
  r2SecretAccessKey: process.env.R2_SECRET_ACCESS_KEY?.trim() || "",
  r2BucketName: process.env.R2_BUCKET_NAME?.trim() || "",
  r2Endpoint: process.env.R2_ENDPOINT?.trim().replace(/\/$/, "") || "",
  frontendUrl: process.env.FRONTEND_URL?.trim().replace(/\/$/, "") || "",
  minFreeDiskMb: num("MIN_FREE_DISK_MB", 1500),
  cleanupIntervalMinutes: num("CLEANUP_INTERVAL_MINUTES", 15),

  /** Ingest --------------------------------------------------------------- */
  maxUploadMb: num("MAX_UPLOAD_MB", 400),
  maxDurationMinutes: num("MAX_DURATION_MINUTES", 120),
  urlDownloadTimeoutSec: num("URL_DOWNLOAD_TIMEOUT_SEC", 600),
  maxUrlSizeMb: num("MAX_URL_SIZE_MB", 800),
  maxUrlRedirects: num("MAX_URL_REDIRECTS", 5),
  /** Direct URL sources are scratch-only unless explicitly retained in R2. */
  persistUrlSources: bool("PERSIST_URL_SOURCES", false),
  /** Reserved for a future provider adapter; direct URLs are V2's safe default. */
  allowYtDlp: bool("ALLOW_YTDLP", false),

  /** Transcription -------------------------------------------------------- */
  groqApiKey: process.env.GROQ_API_KEY?.trim() || "",
  groqTranscribeModel: str("GROQ_TRANSCRIBE_MODEL", "whisper-large-v3-turbo"),
  groqBaseUrl: str("GROQ_BASE_URL", "https://api.groq.com/openai/v1"),
  /** Groq free tier rejects uploads over 25MB, so audio is chunked. */
  audioChunkSec: num("AUDIO_CHUNK_SEC", 600),
  audioChunkOverlapSec: num("AUDIO_CHUNK_OVERLAP_SEC", 1.5),
  transcribeTimeoutSec: num("TRANSCRIBE_TIMEOUT_SEC", 600),

  /** Clip analysis -------------------------------------------------------- */
  openrouterApiKey: process.env.OPENROUTER_API_KEY?.trim() || "",
  openrouterBaseUrl: str("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1"),
  // Keep model IDs environment-configurable: account/model access can differ.
  groqTextModel: str("GROQ_TEXT_MODEL", "openai/gpt-oss-20b"),
  openrouterTextModel: str("OPENROUTER_TEXT_MODEL", "google/gemini-2.5-flash"),
  /** groq first (fast), then openrouter as optional fallback. */
  analysisProviders: str("ANALYSIS_PROVIDERS", "groq,openrouter")
    .split(",")
    .map((p) => p.trim().toLowerCase())
    .filter((p) => p === "groq" || p === "openrouter"),
  analysisTimeoutSec: num("ANALYSIS_TIMEOUT_SEC", 180),
  /** Additional corrected attempts per provider; capped at one in V1. */
  analysisMaxRetries: num("ANALYSIS_MAX_RETRIES", 1),
  analysisCandidateMultiplier: num("ANALYSIS_CANDIDATE_MULTIPLIER", 3),
  analysisTranscriptMaxChars: num("ANALYSIS_TRANSCRIPT_MAX_CHARS", 90_000),

  /** Output --------------------------------------------------------------- */
  targetWidth: num("TARGET_WIDTH", 1080),
  targetHeight: num("TARGET_HEIGHT", 1920),
  targetFps: num("TARGET_FPS", 30),
  videoCrf: num("VIDEO_CRF", 23),
  videoPreset: str("VIDEO_PRESET", "veryfast"),
  audioBitrateK: num("AUDIO_BITRATE_K", 128),

  /** Clip selection ------------------------------------------------------- */
  maxConcurrentJobs: num("MAX_CONCURRENT_JOBS", 1),
  defaultClipCount: num("DEFAULT_CLIP_COUNT", 3),
  maxClipCount: num("MAX_CLIP_COUNT", 8),
  minClipSec: num("MIN_CLIP_SEC", 12),
  maxClipSec: num("MAX_CLIP_SEC", 90),
} as const;

export type AnalysisProvider = "groq" | "openrouter";

export function transcriptionConfigured(): boolean {
  return config.groqApiKey.length > 0;
}

export function providersConfigured(): {
  groq: boolean;
  openrouter: boolean;
  order: AnalysisProvider[];
} {
  const order = config.analysisProviders.filter((p) =>
    p === "groq" ? transcriptionConfigured() : config.openrouterApiKey.length > 0,
  );
  return {
    groq: transcriptionConfigured(),
    openrouter: config.openrouterApiKey.length > 0,
    order,
  };
}
