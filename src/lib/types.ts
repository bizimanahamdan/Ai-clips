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

export type JobStatus = "queued" | "processing" | "completed" | "failed" | "partial";

export type Stage =
  | "queued"
  | "acquiring"
  | "ingesting"
  | "probing"
  | "extracting_audio"
  | "transcribing"
  | "analyzing"
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
  extracting_audio: "Extracting audio",
  transcribing: "Transcribing audio",
  analyzing: "AI is picking moments",
  selecting: "Validating clips",
  rendering: "Cutting vertical clips",
  finalizing: "Finishing up",
  done: "Done",
  failed: "Failed",
};

export const STAGE_WEIGHTS: Record<Exclude<Stage, "done" | "failed">, number> = {
  queued: 1,
  acquiring: 2,
  ingesting: 10,
  probing: 13,
  extracting_audio: 20,
  transcribing: 52,
  analyzing: 64,
  selecting: 68,
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
