import fsp from "node:fs/promises";
import path from "node:path";
import { config } from "./config";
import { AppError, describeHttpStatus } from "./errors";
import { extractAudio, mediaDurationSeconds } from "./ffmpeg";
import type { Transcript, TranscriptSegment, Word } from "./types";

const GROQ_LIMIT_BYTES = 24 * 1024 * 1024; // stay under Groq's 25MB cap

/** Languages supported by multilingual Whisper models (ISO-639-1 codes). */
const WHISPER_LANGUAGE_CODES = new Set([
  "af", "am", "ar", "as", "az", "ba", "be", "bg", "bn", "bo", "br", "bs",
  "ca", "cs", "cy", "da", "de", "el", "en", "es", "et", "eu", "fa", "fi",
  "fo", "fr", "gl", "gu", "ha", "haw", "he", "hi", "hr", "ht", "hu", "hy",
  "id", "is", "it", "ja", "jw", "ka", "kk", "km", "kn", "ko", "la", "lb",
  "ln", "lo", "lt", "lv", "mg", "mi", "mk", "ml", "mn", "mr", "ms", "mt",
  "my", "ne", "nl", "nn", "no", "oc", "pa", "pl", "ps", "pt", "ro", "ru",
  "sa", "sd", "si", "sk", "sl", "sn", "so", "sq", "sr", "su", "sv", "sw",
  "ta", "te", "tg", "th", "tk", "tl", "tr", "tt", "uk", "ur", "uz", "vi",
  "yi", "yo", "zh",
]);

const LANGUAGE_NAME_TO_CODE: Record<string, string> = {
  english: "en",
  french: "fr",
  spanish: "es",
  german: "de",
  italian: "it",
  portuguese: "pt",
  dutch: "nl",
  russian: "ru",
  ukrainian: "uk",
  arabic: "ar",
  swahili: "sw",
  chinese: "zh",
  mandarin: "zh",
  japanese: "ja",
  korean: "ko",
  hindi: "hi",
  turkish: "tr",
  polish: "pl",
  romanian: "ro",
  greek: "el",
  hebrew: "he",
  indonesian: "id",
  malay: "ms",
  vietnamese: "vi",
  thai: "th",
  tamil: "ta",
  telugu: "te",
  urdu: "ur",
  somali: "so",
  amharic: "am",
  hausa: "ha",
  yoruba: "yo",
  malagasy: "mg",
};

// Populate the aliases for every supported code using their English display
// names (for example, Afrikaans → af), while retaining common manual aliases.
const englishLanguageNames = new Intl.DisplayNames(["en"], { type: "language" });
for (const code of WHISPER_LANGUAGE_CODES) {
  const displayName = englishLanguageNames.of(code)?.toLowerCase();
  if (displayName) LANGUAGE_NAME_TO_CODE[displayName] = code;
}

const AUTOMATIC_LANGUAGE_VALUES = new Set([
  "",
  "auto",
  "automatic",
  "automatic detection",
  "auto detect",
  "autodetect",
  "detect",
  "unknown",
  "unspecified",
]);

/**
 * Convert UI language labels/locales to the ISO code accepted by Groq Whisper.
 * Automatic detection returns undefined so no language multipart field is sent.
 */
export function normalizeWhisperLanguage(value?: string | null): string | undefined {
  const normalized = (value ?? "").trim().toLowerCase().replace(/_/g, "-");
  if (AUTOMATIC_LANGUAGE_VALUES.has(normalized)) return undefined;

  const fromName = LANGUAGE_NAME_TO_CODE[normalized];
  if (fromName) return fromName;

  // Accept an ISO code or locale such as en-US, but send only ISO-639-1.
  const code = normalized.match(/^([a-z]{2})(?:-[a-z0-9]{2,8})*$/)?.[1];
  if (code && WHISPER_LANGUAGE_CODES.has(code)) return code;

  const kinyarwandaNote = normalized === "kinyarwanda" || code === "rw"
    ? " Kinyarwanda (rw) is not supported by the configured Whisper model; use automatic detection instead."
    : "";
  throw new AppError(
    "bad_request",
    `Unsupported transcription language: "${value}". Choose automatic detection or a Whisper-supported ISO-639-1 language.`,
    { status: 400, detail: `Examples: English → en, French → fr.${kinyarwandaNote}` },
  );
}

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

  // Normalize and validate once, before creating any Groq request. Full names
  // such as "English" must never reach Whisper's language multipart field.
  const whisperLanguage = normalizeWhisperLanguage(options.language);

  const stat = await fsp.stat(options.audioPath);
  const needsChunking = stat.size > GROQ_LIMIT_BYTES;
  const total = needsChunking ? chunkCountFor(options.durationSec) : 1;
  const chunkSeconds = config.audioChunkSec;
  const overlap = config.audioChunkOverlapSec;

  const segments: TranscriptSegment[] = [];
  const words: Word[] = [];
  let text = "";
  let language: string | null = whisperLanguage ?? null;

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
      language: whisperLanguage,
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
          language: whisperLanguage,
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
  // Fail clearly before doing FFmpeg work or making a provider request.
  const whisperLanguage = normalizeWhisperLanguage(options.language);
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
    language: whisperLanguage,
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
