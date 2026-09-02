import { config } from "./config";
import { AppError } from "./errors";
import type { ClipCandidate, Transcript, Word } from "./types";
import { preferredClipMin } from "./clip-duration";

export type ValidatedClip = ClipCandidate & { index: number; words: Word[] };

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function cleanText(value: unknown, maxLen: number, fallback: string): string {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (!text) return fallback;
  return text.length > maxLen ? `${text.slice(0, maxLen - 1).trimEnd()}…` : text;
}

/**
 * Snap a raw timestamp to the nearest sentence start inside the transcript so
 * clips do not begin mid-word.
 */
function snapToSpeech(seconds: number, words: Word[], mode: "start" | "end"): number {
  if (!words.length) return seconds;
  const window = 3.5;
  const candidates = words.filter((w) => Math.abs(w.start - seconds) <= window);
  if (!candidates.length) return seconds;

  if (mode === "start") {
    // Prefer a word that follows a longer pause (likely a sentence boundary).
    let best = candidates[0];
    let bestGap = -1;
    for (const candidate of candidates) {
      const idx = words.indexOf(candidate);
      const prev = words[idx - 1];
      const gap = prev ? candidate.start - prev.end : 10;
      if (gap > bestGap) {
        bestGap = gap;
        best = candidate;
      }
    }
    return bestGap > 0.35 ? Math.max(0, best.start - 0.15) : seconds;
  }

  const last = candidates[candidates.length - 1];
  return Math.max(seconds, last.end);
}

function endAtSpeechBoundary(start: number, limit: number, words: Word[], preferredMin: number): number {
  const candidates = words.filter((word) => word.end <= limit && word.end >= start + preferredMin);
  if (!candidates.length) return limit;
  const sentenceEnds = candidates.filter((word) => /[.!?][”"']?$/.test(word.word));
  return (sentenceEnds.at(-1) ?? candidates.at(-1))?.end ?? limit;
}

/** Align timestamp fallbacks to the transcript boundaries they actually touch. */
function alignToTranscriptSegments(
  start: number,
  end: number,
  transcript: Transcript,
  maxDuration: number,
): { start: number; end: number } {
  if (!transcript.segments.length) return { start, end };
  const first = transcript.segments.find((segment) => segment.end > start);
  let last: Transcript["segments"][number] | undefined;
  for (let index = transcript.segments.length - 1; index >= 0; index -= 1) {
    if (transcript.segments[index].start < end) {
      last = transcript.segments[index];
      break;
    }
  }
  let alignedStart = first && Math.abs(first.start - start) <= 3 ? first.start : start;
  let alignedEnd = last && Math.abs(last.end - end) <= 3 ? last.end : end;
  if (alignedEnd - alignedStart > maxDuration) {
    // Preserve the natural opening; the final cap is snapped to a sentence end.
    alignedEnd = alignedStart + maxDuration;
  }
  alignedStart = Math.max(0, alignedStart);
  alignedEnd = Math.min(transcript.durationSec, alignedEnd);
  return { start: alignedStart, end: alignedEnd };
}

/** Words that overlap the clip window, with timestamps relative to clip start. */
function wordsInWindow(words: Word[], start: number, end: number): Word[] {
  const inWindow = words.filter((w) => w.end > start + 0.05 && w.start < end - 0.05);
  return inWindow.map((w) => ({
    word: w.word,
    start: Number(Math.max(0, w.start - start).toFixed(3)),
    end: Number(Math.min(end - start, w.end - start).toFixed(3)),
  }));
}

/**
 * Validate the AI output: numbers must be real, inside the video, long enough,
 * and clips must not overlap. Throws if nothing usable survives.
 */
export function validateClips(options: {
  candidates: ClipCandidate[];
  durationSec: number;
  transcript: Transcript;
  requestedClips: number;
  maxClipSec: number;
  rejected?: string[];
}): ValidatedClip[] {
  const rejected = options.rejected ?? [];
  const words = options.transcript.words;
  const maxClipSec = Math.max(
    Math.min(config.minClipSec, options.durationSec),
    Math.min(config.maxClipSec, options.maxClipSec, options.durationSec),
  );
  const targetMinSec = preferredClipMin(maxClipSec, Math.min(config.minClipSec, maxClipSec));
  const issues: string[] = [];

  const seen: ValidatedClip[] = [];
  // Longer, target-range suggestions get first claim on a transcript window.
  // Short minimum-length suggestions remain available only as fallbacks.
  const orderedCandidates = [...options.candidates].sort((a, b) => {
    const aDuration = Number(a.endSec) - Number(a.startSec);
    const bDuration = Number(b.endSec) - Number(b.startSec);
    const aInTarget = Number.isFinite(aDuration) && aDuration >= targetMinSec ? 1 : 0;
    const bInTarget = Number.isFinite(bDuration) && bDuration >= targetMinSec ? 1 : 0;
    if (aInTarget !== bInTarget) return bInTarget - aInTarget;
    return Number(b.score || 0) - Number(a.score || 0);
  });

  for (const candidate of orderedCandidates) {
    const rawStart = Number(candidate.startSec);
    const rawEnd = Number(candidate.endSec);

    if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd)) {
      issues.push(`Dropped "${cleanText(candidate.title, 40, "clip")}": timestamps are not numbers.`);
      continue;
    }

    let start = clamp(rawStart, 0, Math.max(0, options.durationSec - 1));
    let end = clamp(rawEnd, 0, options.durationSec);

    if (end - start < 2) {
      // Repair an obvious swapped range, but never manufacture unrelated
      // dialogue merely to make a collapsed AI suggestion long enough.
      if (rawStart > rawEnd && rawStart - rawEnd >= config.minClipSec) {
        start = clamp(rawEnd, 0, options.durationSec);
        end = clamp(rawStart, 0, options.durationSec);
      } else {
        issues.push(`Dropped "${cleanText(candidate.title, 40, "clip")}": collapsed time range.`);
        continue;
      }
    }

    const selectedSegments = Number.isInteger(candidate.startSegment) && Number.isInteger(candidate.endSegment);
    if (!selectedSegments) {
      const aligned = alignToTranscriptSegments(start, end, options.transcript, maxClipSec);
      start = snapToSpeech(aligned.start, words, "start");
      end = snapToSpeech(aligned.end, words, "end");
    }
    let duration = end - start;

    if (duration > maxClipSec) {
      const limit = start + maxClipSec;
      end = endAtSpeechBoundary(start, limit, words, targetMinSec);
      duration = end - start;
    }
    if (duration < Math.min(config.minClipSec, options.durationSec)) {
      issues.push(
        `Dropped "${cleanText(candidate.title, 40, "clip")}": only ${duration.toFixed(1)}s long (min ${config.minClipSec}s).`,
      );
      continue;
    }

    const overlaps = seen.some((clip) => start < clip.endSec - 0.5 && clip.startSec < end - 0.5);
    if (overlaps) {
      issues.push(`Dropped "${cleanText(candidate.title, 40, "clip")}": overlaps a higher scoring clip.`);
      continue;
    }

    seen.push({
      startSec: Number(start.toFixed(2)),
      endSec: Number(end.toFixed(2)),
      title: cleanText(candidate.title, 80, `Moment ${seen.length + 1}`),
      hook: cleanText(candidate.hook, 60, ""),
      reason: cleanText(candidate.reason, 240, ""),
      score: Number.isFinite(Number(candidate.score))
        ? Math.round(clamp(Number(candidate.score), 1, 100))
        : 50,
      index: 0,
      words: wordsInWindow(words, start, end),
    });
  }

  // Complete target-range stories outrank short fallback snippets; score then
  // decides among candidates in the same duration tier.
  seen.sort((a, b) => {
    const aPreferred = a.endSec - a.startSec >= targetMinSec ? 1 : 0;
    const bPreferred = b.endSec - b.startSec >= targetMinSec ? 1 : 0;
    return aPreferred === bPreferred ? b.score - a.score : bPreferred - aPreferred;
  });
  const limited = seen.slice(0, Math.max(1, options.requestedClips));
  limited.forEach((clip, index) => {
    clip.index = index;
  });
  rejected.push(...issues);

  if (!limited.length) {
    throw new AppError(
      "no_clips",
      "No clip suggestions survived validation.",
      {
        detail:
          issues.length
            ? `Model returned ${options.candidates.length} candidate(s). ${issues.join(" ")}`
            : `Model returned ${options.candidates.length} candidate(s) but none fit the video (duration ${options.durationSec.toFixed(1)}s).`,
      },
    );
  }

  return limited;
}
