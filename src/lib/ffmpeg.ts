import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { AppError } from "./errors";

/**
 * Binary resolution.
 *
 * Bundlers rewrite `__dirname`, which breaks ffmpeg-static's own path lookup
 * (it ends up as /ROOT/node_modules/...). So we resolve explicitly:
 *   1. explicit env override (FFMPEG_PATH / FFPROBE_PATH)
 *   2. the npm static binaries inside node_modules, verified on disk
 *   3. whatever is on PATH
 */
function firstExisting(candidates: string[]): string | null {
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* ignore */
    }
  }
  return null;
}

function whichSync(bin: string): string | null {
  try {
    const out = execFileSync("which", [bin], { encoding: "utf8" }).trim();
    return out && fs.existsSync(out) ? out : null;
  } catch {
    return null;
  }
}

const binaryCache = new Map<string, string>();

function resolveBinary(kind: "ffmpeg" | "ffprobe"): string {
  const cached = binaryCache.get(kind);
  if (cached) return cached;

  const override = process.env[kind === "ffmpeg" ? "FFMPEG_PATH" : "FFPROBE_PATH"];
  if (override && fs.existsSync(override)) return override;

  const roots = [process.cwd(), path.join(process.cwd(), ".."), "/app", "/app/server"];
  const staticCandidates: string[] = [];
  for (const root of roots) {
    if (kind === "ffmpeg") {
      staticCandidates.push(path.join(root, "node_modules", "ffmpeg-static", kind));
    } else {
      staticCandidates.push(
        path.join(root, "node_modules", "ffprobe-static", "bin", process.platform, process.arch, "ffprobe"),
        path.join(root, "node_modules", "ffprobe-static", "bin", process.platform, "x64", "ffprobe"),
      );
    }
  }

  const resolved = firstExisting(staticCandidates) ?? whichSync(kind);
  if (!resolved) {
    throw new AppError(
      "ffmpeg_error",
      `Could not find a usable ${kind} binary on this server.`,
      {
        detail:
          "Install it (apt-get install -y ffmpeg) or keep node_modules/ffmpeg-static present, or set FFMPEG_PATH / FFPROBE_PATH.",
      },
    );
  }
  binaryCache.set(kind, resolved);
  return resolved;
}

/**
 * Resolved lazily (not at import) so a misconfigured host still boots and the
 * health endpoint can report the problem instead of crashing every route.
 */
export function ffmpegBin(): string {
  return resolveBinary("ffmpeg");
}

export function ffprobeBin(): string {
  return resolveBinary("ffprobe");
}


export type ProbeResult = {
  durationSec: number;
  width: number | null;
  height: number | null;
  fps: number | null;
  hasVideo: boolean;
  hasAudio: boolean;
  videoCodec: string | null;
  audioCodec: string | null;
  sizeBytes: number;
  bitrate: number | null;
};

function run(
  bin: string,
  args: string[],
  options: {
    timeoutSec?: number;
    onStderr?: (chunk: string) => void;
    capture?: boolean;
    cwd?: string;
  } = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = options.timeoutSec
      ? setTimeout(() => {
          if (!settled) {
            settled = true;
            child.kill("SIGKILL");
            reject(
              new AppError(
                "ffmpeg_error",
                `${path.basename(bin)} timed out after ${options.timeoutSec}s.`,
                { detail: `args: ${args.join(" ").slice(0, 500)}` },
              ),
            );
          }
        }, options.timeoutSec * 1000)
      : null;

    child.stdout.on("data", (d: Buffer) => {
      if (options.capture !== false) stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      const text = d.toString();
      if (options.capture !== false) stderr += text;
      if (stderr.length > 200_000) stderr = stderr.slice(-100_000);
      options.onStderr?.(text);
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(
        new AppError("ffmpeg_error", `Could not start ${path.basename(bin)}: ${err.message}`, {
          detail: err.stack,
        }),
      );
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else {
        const tail = stderr.trim().split("\n").slice(-8).join("\n");
        reject(
          new AppError(
            "ffmpeg_error",
            `${path.basename(bin)} exited with code ${code ?? signal}. ${lastMeaningfulLine(stderr)}`,
            { detail: tail || `args: ${args.join(" ").slice(0, 800)}` },
          ),
        );
      }
    });
  });
}

function lastMeaningfulLine(stderr: string): string {
  const lines = stderr
    .split("\n")
    .map((l) => l.trim())
    .filter(
      (l) =>
        /error|invalid|no such|corrupt|moov atom|not found|failed|unable|does not match/i.test(
          l,
        ) && !/^frame=/.test(l),
    );
  return lines.length ? `Last error: ${lines[lines.length - 1].slice(0, 300)}` : "";
}

/** Verify the binaries actually run (fails loudly on broken deployments). */
let binaryCheck: Promise<{ ffmpeg: string; ffprobe: string }> | null = null;
export function checkBinaries(): Promise<{ ffmpeg: string; ffprobe: string }> {
  if (!binaryCheck) {
    binaryCheck = (async () => {
      const ff = await run(ffmpegBin(), ["-hide_banner", "-version"], { capture: true });
      const fp = await run(ffprobeBin(), ["-hide_banner", "-version"], { capture: true });
      return {
        ffmpeg: ff.stdout.split("\n")[0]?.trim() ?? "ffmpeg",
        ffprobe: fp.stdout.split("\n")[0]?.trim() ?? "ffprobe",
      };
    })().catch((err) => {
      binaryCheck = null;
      throw err;
    });
  }
  return binaryCheck;
}

/** Run ffmpeg with raw args — used by the deployment self-test endpoint. */
export async function runFfmpegArgs(args: string[]): Promise<void> {
  await run(ffmpegBin(), args, { capture: true, timeoutSec: 300 });
}

export async function probeVideo(filePath: string): Promise<ProbeResult> {
  let stat: fs.Stats;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    throw new AppError("unsupported_media", "Video file is missing on disk before probing.");
  }
  if (stat.size === 0) {
    throw new AppError("unsupported_media", "Video file is empty (0 bytes).");
  }

  const { stdout } = await run(
    ffprobeBin(),
    [
      "-v",
      "error",
      "-show_entries",
      "stream=index,codec_type,codec_name,width,height,avg_frame_rate,duration",
      "-show_entries",
      "format=duration,size,bit_rate",
      "-of",
      "json",
      filePath,
    ],
    { capture: true, timeoutSec: 120 },
  );

  let parsed: {
    streams?: Array<Record<string, string | number | null>>;
    format?: Record<string, string | number | null>;
  };
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new AppError("unsupported_media", "Could not read video metadata (ffprobe gave no JSON).");
  }

  const streams = parsed.streams ?? [];
  const video = streams.find((s) => s.codec_type === "video");
  const audio = streams.find((s) => s.codec_type === "audio");

  if (!video && !audio) {
    throw new AppError(
      "unsupported_media",
      "This file has no playable video or audio streams. It may be corrupted or an unsupported container.",
    );
  }

  const formatDuration = Number(parsed.format?.duration ?? 0);
  const streamDuration = Number(video?.duration ?? audio?.duration ?? 0);
  const durationSec = Number.isFinite(formatDuration) && formatDuration > 0
    ? formatDuration
    : Number.isFinite(streamDuration)
      ? streamDuration
      : 0;

  if (!durationSec) {
    throw new AppError(
      "unsupported_media",
      "Could not determine the video duration — the file is likely truncated or still downloading.",
    );
  }

  const fpsRaw = String(video?.avg_frame_rate ?? "0/0");
  const [num, den] = fpsRaw.split("/").map(Number);
  const fps = den ? num / den : 0;

  return {
    durationSec,
    width: video?.width ? Number(video.width) : null,
    height: video?.height ? Number(video.height) : null,
    fps: Number.isFinite(fps) && fps > 0 ? fps : null,
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
    videoCodec: video?.codec_name ? String(video.codec_name) : null,
    audioCodec: audio?.codec_name ? String(audio.codec_name) : null,
    sizeBytes: stat.size,
    bitrate: parsed.format?.bit_rate ? Number(parsed.format.bit_rate) : null,
  };
}

/**
 * Extract 16kHz mono FLAC audio (small + lossless enough for Whisper).
 * Optionally only a slice, used for chunking long videos.
 */
export async function extractAudio(options: {
  input: string;
  output: string;
  startSec?: number;
  durationSec?: number;
}): Promise<void> {
  const args = ["-hide_banner", "-loglevel", "error", "-y"];
  if (options.startSec !== undefined) args.push("-ss", options.startSec.toFixed(3));
  args.push("-i", options.input);
  if (options.durationSec !== undefined) args.push("-t", options.durationSec.toFixed(3));
  args.push("-vn", "-map", "0:a:0", "-ar", "16000", "-ac", "1", "-c:a", "flac", options.output);
  await run(ffmpegBin(), args, { timeoutSec: 900 });
}

export async function mediaDurationSeconds(filePath: string): Promise<number> {
  const { stdout } = await run(
    ffprobeBin(),
    ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", filePath],
    { capture: true, timeoutSec: 60 },
  );
  const value = Number(stdout.trim());
  return Number.isFinite(value) ? value : 0;
}

export type RenderProgress = (ratio: number) => void;

/**
 * Cut + reframe + burn subtitles in a single ffmpeg pass (low disk, low CPU).
 */
export async function renderVerticalClip(options: {
  input: string;
  output: string;
  startSec: number;
  endSec: number;
  subtitlePath?: string;
  subtitlesEnabled: boolean;
  targetWidth: number;
  targetHeight: number;
  targetFps: number;
  crf: number;
  preset: string;
  audioBitrateK: number;
  hasAudio: boolean;
  onProgress?: RenderProgress;
}): Promise<void> {
  const duration = Math.max(0.5, options.endSec - options.startSec);
  const crop = [
    `crop=w='min(iw,ih*${options.targetWidth}/${options.targetHeight})':h='min(ih,iw*${options.targetHeight}/${options.targetWidth})'`,
    `scale=${options.targetWidth}:${options.targetHeight}:force_original_aspect_ratio=increase`,
    `crop=${options.targetWidth}:${options.targetHeight}`,
    `fps=${options.targetFps}`,
    "setsar=1",
  ];
  if (options.subtitlesEnabled && options.subtitlePath) {
    crop.push(`ass=${quoteFilterPath(options.subtitlePath)}:fontsdir=${quoteFilterPath(fontsDir())}`);
  }
  const vf = crop.join(",");

  const args = [
    "-hide_banner",
    "-loglevel",
    "warning",
    "-stats",
    "-y",
    "-ss",
    options.startSec.toFixed(3),
    "-i",
    options.input,
    "-t",
    duration.toFixed(3),
    "-vf",
    vf,
  ];

  if (options.hasAudio) {
    args.push("-map", "0:v:0", "-map", "0:a:0?", "-c:a", "aac", "-b:a", `${options.audioBitrateK}k`, "-ar", "44100", "-ac", "2");
  } else {
    args.push("-map", "0:v:0", "-an");
  }

  args.push(
    "-c:v",
    "libx264",
    "-preset",
    options.preset,
    "-crf",
    String(options.crf),
    "-pix_fmt",
    "yuv420p",
    "-profile:v",
    "high",
    "-movflags",
    "+faststart",
    "-max_muxing_queue_size",
    "1024",
    options.output,
  );

  await run(ffmpegBin(), args, {
    timeoutSec: Math.max(300, Math.round(duration * 12)),
    onStderr: (chunk) => {
      if (!options.onProgress) return;
      const matches = chunk.matchAll(/time=(\d+):(\d+):(\d+\.\d+)/g);
      let last = -1;
      for (const m of matches) {
        const seconds = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
        last = Math.min(1, seconds / duration);
      }
      if (last >= 0) options.onProgress(last);
    },
  });
}

function quoteFilterPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

function fontsDir(): string {
  const candidates = [
    "/usr/share/fonts/truetype/dejavu",
    "/usr/share/fonts/dejavu",
    "/usr/share/fonts",
    path.join(process.cwd(), "assets", "fonts"),
  ];
  for (const dir of candidates) {
    try {
      if (fs.existsSync(dir)) return dir;
    } catch {
      /* ignore */
    }
  }
  return process.cwd();
}

/** Pull a still frame so the UI can show a poster for each clip. */
export async function extractPoster(options: {
  input: string;
  output: string;
  atSec: number;
  width: number;
}): Promise<boolean> {
  try {
    await run(
      ffmpegBin(),
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-ss",
        Math.max(0, options.atSec).toFixed(3),
        "-i",
        options.input,
        "-frames:v",
        "1",
        "-vf",
        `scale=${options.width ?? 270}:-2`,
        "-q:v",
        "4",
        options.output,
      ],
      { capture: true, timeoutSec: 120 },
    );
    return fs.existsSync(options.output);
  } catch {
    return false;
  }
}
