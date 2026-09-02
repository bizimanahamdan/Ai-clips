export type Word = { start: number; end: number; word: string };

export type TranscriptSegment = {
  start: number;
  end: number;
  text: string;
};

export type Transcript = {
  language: string | null;
  durationSec: number;
  text: string;
  segments: TranscriptSegment[];
  words: Word[];
  chunkCount: number;
  model: string;
};

export type ClipCandidate = {
  startSec: number;
  endSec: number;
  /** Present when the AI selected indexed transcript boundaries. */
  startSegment?: number;
  endSegment?: number;
  title: string;
  hook: string;
  reason: string;
  score: number;
};

export type AnalysisCheckpointAttempt = {
  provider: "gemini" | "openrouter" | "groq";
  model: string;
  attempt: number;
  outcome: "failed" | "succeeded";
  detail: string;
  phase?: "discovery" | "selection";
  chunk?: number;
};

export type AnalysisChunkCheckpoint = {
  index: number;
  startSegment: number;
  endSegment: number;
  startSec: number;
  endSec: number;
  characterCount: number;
  estimatedTokens: number;
  block: string;
  status: "pending" | "succeeded" | "failed";
  candidates: ClipCandidate[];
  attempts: AnalysisCheckpointAttempt[];
  error?: string;
};

/** One resumable JSONB document, keyed by job + deterministic chunk index. */
export type AnalysisCheckpoint = {
  version: 1;
  signature: string;
  chunks: AnalysisChunkCheckpoint[];
  finalClips?: ClipCandidate[];
  selectionComplete: boolean;
  provider?: "gemini" | "openrouter" | "groq";
  model?: string;
  raw?: string;
  selectionAttempts?: AnalysisCheckpointAttempt[];
  updatedAt: string;
};

export type JobStatus = "queued" | "processing" | "completed" | "failed" | "partial" | "cleanup_pending";

export type Stage =
  | "queued"
  | "acquiring"
  | "ingesting"
  | "probing"
  | "analyzing_music"
  | "extracting_audio"
  | "transcribing"
  | "preparing_transcript"
  | "analyzing"
  | "ranking"
  | "selecting"
  | "rendering"
  | "finalizing"
  | "done"
  | "failed";

export const STAGE_LABELS: Record<Stage, string> = {
  queued: "Queued",
  acquiring: "Acquiring source video",
  ingesting: "Getting the video",
  probing: "Checking the video",
  analyzing_music: "Analyzing background music",
  extracting_audio: "Extracting audio",
  transcribing: "Transcribing audio",
  preparing_transcript: "Preparing transcript",
  analyzing: "AI is analyzing transcript parts",
  ranking: "Ranking best moments",
  selecting: "Selecting final clips",
  rendering: "Cutting vertical clips",
  finalizing: "Finishing up",
  done: "Done",
  failed: "Failed",
};

export const STAGE_WEIGHTS: Record<Exclude<Stage, "done" | "failed">, number> = {
  queued: 1,
  acquiring: 4,
  ingesting: 10,
  probing: 13,
  analyzing_music: 2,
  extracting_audio: 20,
  transcribing: 52,
  preparing_transcript: 55,
  analyzing: 64,
  ranking: 67,
  selecting: 69,
  rendering: 97,
  finalizing: 99,
};

export type ApiClip = {
  id: string;
  clipIndex: number;
  status: string;
  title: string;
  hook: string | null;
  reason: string | null;
  score: number | null;
  startSec: number;
  endSec: number;
  durationSec: number | null;
  fileSizeBytes: number | null;
  width: number | null;
  height: number | null;
  error: string | null;
  musicAssetId: string | null;
  musicVolume: number | null;
  musicEnabled: boolean;
  musicStatus: string;
  musicError: string | null;
  playbackUrl: string | null;
  downloadUrl: string | null;
};

export type ApiJobEvent = {
  id: number;
  level: string;
  stage: string;
  message: string;
  createdAt: string;
};

export type ApiJob = {
  id: string;
  status: JobStatus;
  stage: Stage;
  stageLabel: string;
  stageDetail: string | null;
  progress: number;
  sourceType: string;
  sourceName: string;
  durationSec: number | null;
  width: number | null;
  height: number | null;
  fileSizeBytes: number | null;
  language: string | null;
  requestedClips: number;
  maxClipSec: number;
  subtitlesEnabled: boolean;
  outputFormat: "9:16" | "1:1" | "16:9";
  musicFileName: string | null;
  mediaMode: "none" | "manual" | "auto";
  musicAssetIds: string[];
  soundEffectAssetIds: string[];
  analysisProvider: string | null;
  analysisModel: string | null;
  error: { message: string; stage: string; detail?: string; kind?: string } | null;
  createdAt: string;
  finishedAt: string | null;
  expiresAt: string | null;
  clips: ApiClip[];
  events: ApiJobEvent[];
  transcriptPreview: string | null;
};
