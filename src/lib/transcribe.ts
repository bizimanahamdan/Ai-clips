import fsp from "node:fs/promises";
import path from "node:path";
import { config } from "./config";
import { AppError, describeHttpStatus } from "./errors";
import { extractAudio, mediaDurationSeconds } from "./ffmpeg";
import type { Transcript, TranscriptSegment, Word } from "./types";

const GROQ_LIMIT_BYTES = 24 * 1024 * 1024; // stay under Groq's 25MB cap

type GroqVerboseResponse = {
  text?: string;
  language?: string;
  duration?: number;
  segments?: Array<{ start?: number; end?: number; text?: string }>;
  words?: Array<{ start?: number; end?: number; word?: string }>;
};

export function chunkCountFor(durationSec: number): number {
  return Math.max(1, Math.ceil(durationSec / config.audioChunkSec));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function transcribeChunkFile(options: {
  filePath: string;
  index: number;
  total: number;
  language?: string;
  isLast: boolean;
  chunkSpan: number;
  offsetSec: number;
}): Promise<{ segments: TranscriptSegment[]; words: Word[]; text: string; language: string | null }> {
  const stat = await fsp.stat(options.filePath);
  if (stat.size > GROQ_LIMIT_BYTES) {
    throw new AppError(
      "too_large",
      `Audio chunk ${options.index + 1} is ${(stat.size / (1024 * 1024)).toFixed(1)}MB, above Groq's 25MB limit.`,
      { detail: "Set AUDIO_CHUNK_SEC lower (e.g. 300) so each chunk is smaller." },
    );
  }

  const bytes = await fsp.readFile(options.filePath);
  const form = new FormData();
  form.append(
    "file",
    new Blob([new Uint8Array(bytes)], { type: "audio/flac" }),
    path.basename(options.filePath),
  );
  form.append("model", config.groqTranscribeModel);
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "segment");
  form.append("timestamp_granularities[]", "word");
  form.append("temperature", "0");
  if (options.language) form.append("language", options.language);

  const maxAttempts = 4;
  let lastError: AppError | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.transcribeTimeoutSec * 1000);
    try {
      const response = await fetch(`${config.groqBaseUrl}/audio/transcriptions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${config.groqApiKey}` },
        body: form,
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        const error = describeHttpStatus(response.status, "Groq Whisper", body);
        if (!error.retryable) throw error;
        lastError = error;
      } else {
        const parsed = (await response.json()) as GroqVerboseResponse;
        const segments: TranscriptSegment[] = [];
        const words: Word[] = [];

        for (const segment of parsed.segments ?? []) {
          const segStart = Number(segment.start ?? 0);
          const segEnd = Number(segment.end ?? 0);
          const segText = (segment.text ?? "").trim();
          if (!segText) continue;
          if (!options.isLast && segStart >= options.chunkSpan - 0.05) continue; // overlap dupe
          segments.push({
            start: Number((options.offsetSec + segStart).toFixed(3)),
            end: Number((options.offsetSec + Math.min(segEnd, options.chunkSpan || segEnd)).toFixed(3)),
            text: segText,
          });
        }

        for (const word of parsed.words ?? []) {
          const wStart = Number(word.start ?? 0);
          const wEnd = Number(word.end ?? wStart + 0.2);
          const wText = (word.word ?? "").trim();
          if (!wText) continue;
          if (!options.isLast && wStart >= options.chunkSpan - 0.05) continue;
          words.push({
            start: Number((options.offsetSec + wStart).toFixed(3)),
            end: Number((options.offsetSec + Math.min(wEnd, options.chunkSpan || wEnd)).toFixed(3)),
            word: wText,
          });
        }

        return {
          segments,
          words,
          text: (parsed.text ?? "").trim(),
          language: parsed.language ?? null,
        };
      }
    } catch (error) {
      if (error instanceof AppError) {
        if (!error.retryable) throw error;
        lastError = error;
      } else if ((error as Error).name === "AbortError") {
        lastError = new AppError(
          "transcription_failed",
          `Groq transcription timed out after ${config.transcribeTimeoutSec}s.`,
          { retryable: true },
        );
      } else {
        lastError = new AppError("transcription_failed", `Could not reach Groq: ${(error as Error).message}`, {
          retryable: true,
        });
      }
    } finally {
      clearTimeout(timer);
    }

    if (attempt < maxAttempts) await sleep(Math.min(30_000, 1500 * 2 ** (attempt - 1)));
  }

  throw lastError ?? new AppError("transcription_failed", "Groq transcription failed after several retries.");
}

/**
 * Transcribe an already-extracted audio file. Chunks it if it is too big for a
 * single Groq request, then merges and re-bases all timestamps.
 */
export async function transcribeAudioFile(options: {
  audioPath: string;
  workDir: string;
  durationSec: number;
  language?: string | null;
  onProgress?: (ratio: number, message: string) => void;
}): Promise<Transcript> {
  if (!config.groqApiKey) {
    throw new AppError(
      "missing_api_key",
      "GROQ_API_KEY is not set on the server, so audio cannot be transcribed.",
      { status: 503 },
    );
  }

  const stat = await fsp.stat(options.audioPath);
  const needsChunking = stat.size > GROQ_LIMIT_BYTES;
  const total = needsChunking ? chunkCountFor(options.durationSec) : 1;
  const chunkSeconds = config.audioChunkSec;
  const overlap = config.audioChunkOverlapSec;

  const segments: TranscriptSegment[] = [];
  const words: Word[] = [];
  let text = "";
  let language: string | null = options.language ?? null;

  const collect = (
    result: { segments: TranscriptSegment[]; words: Word[]; text: string; language: string | null },
    isLast: boolean,
    chunkSpan: number,
    offsetSec: number,
  ) => {
    if (result.language && !language) language = result.language;
    if (result.text) text += (text ? " " : "") + result.text;
    segments.push(...result.segments.map((s) => ({ ...s, start: s.start + offsetSec, end: s.end + offsetSec })));
    words.push(...result.words.map((w) => ({ ...w, start: w.start + offsetSec, end: w.end + offsetSec })));
    void isLast;
    void chunkSpan;
  };

  if (!needsChunking) {
    const result = await transcribeChunkFile({
      filePath: options.audioPath,
      index: 0,
      total: 1,
      language: options.language ?? undefined,
      isLast: true,
      chunkSpan: options.durationSec,
      offsetSec: 0,
    });
    collect(result, true, options.durationSec, 0);
    options.onProgress?.(1, "Transcription complete");
  } else {
    for (let index = 0; index < total; index += 1) {
      const startSec = index * chunkSeconds;
      const requestDuration = Math.min(chunkSeconds + overlap, options.durationSec - startSec);
      if (requestDuration <= 0.2) break;

      const chunkPath = path.join(options.workDir, `chunk-${index}.flac`);
      await extractAudio({
        input: options.audioPath,
        output: chunkPath,
        startSec,
        durationSec: requestDuration,
      });
      const actual = await mediaDurationSeconds(chunkPath);
      if (!actual) {
        await fsp.rm(chunkPath, { force: true });
        break;
      }

      const isLast = index === total - 1;
      const chunkSpan = isLast ? actual : Math.max(0, actual - overlap);

      try {
        const result = await transcribeChunkFile({
          filePath: chunkPath,
          index,
          total,
          language: options.language ?? undefined,
          isLast,
          chunkSpan,
          offsetSec: startSec,
        });
        collect(result, isLast, chunkSpan, 0);
      } finally {
        await fsp.rm(chunkPath, { force: true });
      }

      options.onProgress?.(
        (index + 1) / total,
        `Transcribed ${index + 1}/${total} audio chunks`,
      );
    }
  }

  if (!segments.length && !words.length) {
    throw new AppError(
      "transcription_failed",
      "Transcription returned no words. The audio may be silent, music-only, or too noisy for speech recognition.",
    );
  }

  const finalSegments = segments.length ? segments : wordsToSegments(words);
  finalSegments.sort((a, b) => a.start - b.start);
  words.sort((a, b) => a.start - b.start);

  return {
    language,
    durationSec: options.durationSec,
    text: text.trim() || finalSegments.map((s) => s.text).join(" "),
    segments: finalSegments,
    words,
    chunkCount: total,
    model: config.groqTranscribeModel,
  };
}

/**
 * Extract a single 16kHz mono FLAC from the source video (one decode pass),
 * then transcribe it. Also acts as an early "audio is decodable" check.
 */
export async function extractAndTranscribe(options: {
  videoPath: string;
  workDir: string;
  durationSec: number;
  language?: string | null;
  onProgress?: (ratio: number, message: string) => void;
}): Promise<{ transcript: Transcript; audioPath: string; audioBytes: number }> {
  const audioPath = path.join(options.workDir, "source-audio.flac");
  await extractAudio({ input: options.videoPath, output: audioPath });

  const stat = await fsp.stat(audioPath);
  if (stat.size < 1024) {
    await fsp.rm(audioPath, { force: true });
    throw new AppError(
      "unsupported_media",
      "The audio track could not be decoded (output was empty). The video may have a broken or silent audio stream.",
    );
  }

  const transcript = await transcribeAudioFile({
    audioPath,
    workDir: options.workDir,
    durationSec: options.durationSec,
    language: options.language,
    onProgress: options.onProgress,
  });

  return { transcript, audioPath, audioBytes: stat.size };
}

function wordsToSegments(words: Word[]): TranscriptSegment[] {
  const out: TranscriptSegment[] = [];
  let current: Word[] = [];
  const flush = () => {
    if (!current.length) return;
    out.push({
      start: current[0].start,
      end: current[current.length - 1].end,
      text: current.map((w) => w.word).join(" "),
    });
    current = [];
  };
  for (const word of words) {
    current.push(word);
    const span = word.end - current[0].start;
    if (/[.!?]$/.test(word.word) || span > 8 || current.length > 30) flush();
  }
  flush();
  return out;
}
