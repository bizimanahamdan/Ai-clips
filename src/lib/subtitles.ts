import type { Word } from "./types";

const MAX_CPS_BREAK = 16; // max words per caption group

export type CaptionGroup = {
  start: number;
  end: number;
  words: Array<{ word: string; start: number; end: number }>;
};

/**
 * Group word timestamps into short, readable caption chunks (2-4 words).
 * Groups break on punctuation and long pauses so captions feel like speech.
 */
export function buildCaptionGroups(words: Word[]): CaptionGroup[] {
  const groups: CaptionGroup[] = [];
  let current: Word[] = [];

  const flush = () => {
    if (!current.length) return;
    groups.push({
      start: current[0].start,
      end: current[current.length - 1].end,
      words: current.map((w) => ({ word: w.word, start: w.start, end: w.end })),
    });
    current = [];
  };

  for (const word of words) {
    if (!Number.isFinite(word.start) || !Number.isFinite(word.end)) continue;
    if (word.end <= word.start) word.end = word.start + 0.2;
    current.push(word);

    const span = word.end - current[0].start;
    const gapAhead = 0; // handled below by comparing next word
    void gapAhead;
    const breakOnPunctuation = /[.!?…,;:]$/.test(word.word);
    if (current.length >= MAX_CPS_BREAK || span > 2.2 || breakOnPunctuation) {
      flush();
    }
  }
  flush();

  // Bridge small gaps so captions do not flash off between groups.
  for (let i = 0; i < groups.length - 1; i += 1) {
    const gap = groups[i + 1].start - groups[i].end;
    if (gap > 0 && gap < 0.4) groups[i].end = groups[i + 1].start;
  }
  // Never let a caption disappear instantly.
  for (const group of groups) {
    if (group.end - group.start < 0.5) group.end = group.start + 0.5;
  }
  return groups;
}

function assTime(seconds: number): string {
  const s = Math.max(0, seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}:${String(m).padStart(2, "0")}:${sec.toFixed(2).padStart(5, "0")}`;
}

function escapeAss(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/[{}]/g, "").replace(/\r?\n/g, " ");
}

export type SubtitleOptions = {
  width: number;
  height: number;
  /** Vertical position of the caption block (px from bottom). */
  marginV: number;
  fontName: string;
  fontSize: number;
  /** Highlight the currently spoken word in a colour (ASS BGR hex). */
  highlightColour: string;
  baseColour: string;
  outlineColour: string;
};

export const DEFAULT_SUBTITLE_OPTIONS: SubtitleOptions = {
  width: 1080,
  height: 1920,
  marginV: 420,
  fontName: "DejaVu Sans",
  fontSize: 84,
  baseColour: "&H00FFFFFF",
  highlightColour: "&H0000D7FF",
  outlineColour: "&H00101010",
};

function assHeader(options: SubtitleOptions): string {
  return [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${options.width}`,
    `PlayResY: ${options.height}`,
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "YCbCr Matrix: TV.709",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Cap,${options.fontName},${options.fontSize},${options.baseColour},${options.highlightColour},${options.outlineColour},&H64000000,-1,0,0,0,100,100,1,0,1,7,3,2,80,80,${options.marginV},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ].join("\n");
}

/**
 * Generate a karaoke-style ASS file: the whole caption group is visible and the
 * currently spoken word is tinted, which reads well on a phone screen.
 */
export function buildAssSubtitles(groups: CaptionGroup[], options: SubtitleOptions): string {
  const lines: string[] = [assHeader(options)];

  for (const group of groups) {
    const parts = group.words.map((word, index) => {
      const highlight =
        index === 0
          ? `{\\k${Math.max(1, Math.round((word.end - group.start) * 100))}}`
          : `{\\k${Math.max(1, Math.round((word.end - word.start) * 100))}}`;
      return `${highlight}${escapeAss(word.word)}`;
    });
    const text = parts.join(" ");
    lines.push(
      `Dialogue: 0,${assTime(group.start)},${assTime(group.end)},Cap,,0,0,0,,{\\fad(60,60)}${text}`,
    );
  }

  return `${lines.join("\n")}\n`;
}

/** Plain SRT fallback (used when there are no word timestamps). */
export function buildSrt(segments: Array<{ start: number; end: number; text: string }>): string {
  const srtTime = (seconds: number) => {
    const s = Math.max(0, seconds);
    const h = String(Math.floor(s / 3600)).padStart(2, "0");
    const m = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
    const sec = String(Math.floor(s % 60)).padStart(2, "0");
    const ms = String(Math.round((s % 1) * 1000)).padStart(3, "0");
    return `${h}:${m}:${sec},${ms}`;
  };
  return segments
    .map((segment, index) => {
      return `${index + 1}\n${srtTime(segment.start)} --> ${srtTime(segment.end)}\n${escapeAss(segment.text).replace(/\{[^}]*\}/g, "")}\n`;
    })
    .join("\n");
}

/**
 * Pick subtitle sizing. Smaller sources get a proportionally smaller canvas so
 * 480p uploads still get readable, well-proportioned captions.
 */
export function subtitleOptionsFor(width: number, height: number): SubtitleOptions {
  const base = DEFAULT_SUBTITLE_OPTIONS;
  if (width >= 1000) return base;
  const scale = Math.max(0.6, width / 1080);
  return {
    ...base,
    width,
    height,
    fontSize: Math.round(base.fontSize * scale),
    marginV: Math.round(base.marginV * scale),
  };
}
