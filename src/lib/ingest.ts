import { createWriteStream } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { config } from "./config";
import { AppError } from "./errors";
import { checkBinaries, probeVideo, type ProbeResult } from "./ffmpeg";
import { uploadsRoot } from "./storage";

const SUPPORTED_EXT = [
  ".mp4",
  ".mov",
  ".mkv",
  ".webm",
  ".m4v",
  ".avi",
  ".flv",
  ".mpg",
  ".mpeg",
  ".ts",
  ".3gp",
  ".wmv",
];

export function sanitizeFileName(name: string): string {
  const base = path.basename(name || "video.mp4");
  const cleaned = base.replace(/[^a-zA-Z0-9._ -]/g, "_").trim();
  return cleaned.length ? cleaned.slice(0, 120) : "video.mp4";
}

export function looksSupported(fileName: string): boolean {
  return SUPPORTED_EXT.includes(path.extname(fileName).toLowerCase());
}

export function extensionFor(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase();
  return SUPPORTED_EXT.includes(ext) ? ext : ".mp4";
}

/**
 * Stream an uploaded body straight to disk. Never buffers a whole video in RAM,
 * which matters a lot on a small cloud instance.
 */
export async function saveUploadStream(options: {
  body: ReadableStream<Uint8Array> | null;
  fileName: string;
  maxBytes: number;
}): Promise<{ filePath: string; sizeBytes: number }> {
  await fsp.mkdir(uploadsRoot(), { recursive: true });
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const filePath = path.join(uploadsRoot(), `${id}${extensionFor(options.fileName)}`);

  if (!options.body) {
    throw new AppError("bad_request", "Upload body was empty.");
  }

  const limit = options.maxBytes;
  let written = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _enc: unknown, callback: (err: Error | null, data?: Buffer) => void) {
      written += chunk.byteLength;
      if (written > limit) {
        callback(
          new AppError(
            "too_large",
            `Upload is larger than the ${Math.round(limit / (1024 * 1024))}MB limit. Trim the file or raise MAX_UPLOAD_MB.`,
            { status: 413 },
          ),
        );
        return;
      }
      callback(null, chunk);
    },
  });

  try {
    await pipeline(
      Readable.fromWeb(options.body as Parameters<typeof Readable.fromWeb>[0]),
      limiter,
      createWriteStream(filePath),
    );
  } catch (error) {
    await fsp.rm(filePath, { force: true });
    if (error instanceof AppError) throw error;
    throw new AppError("bad_request", `Upload failed before it finished: ${(error as Error).message}`);
  }

  if (!written) {
    await fsp.rm(filePath, { force: true });
    throw new AppError("bad_request", "Uploaded file was empty.");
  }

  return { filePath, sizeBytes: written };
}

export type DownloadResult = {
  filePath: string;
  sizeBytes: number;
  contentType: string | null;
};

/** Download a direct media URL to disk, with a hard size cap and timeout. */
export async function downloadFromUrl(options: {
  url: string;
  jobId: string;
  onProgress?: (bytes: number, totalBytes: number | null) => void;
}): Promise<DownloadResult> {
  let parsed: URL;
  try {
    parsed = new URL(options.url);
  } catch {
    throw new AppError("bad_request", "That URL could not be parsed.");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new AppError("bad_request", "Only http(s) URLs are supported.");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.urlDownloadTimeoutSec * 1000);

  try {
    const response = await fetch(parsed, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        // Some CDNs reject requests without a browser-ish UA.
        "User-Agent":
          "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36",
        Accept: "video/*,audio/*,*/*;q=0.8",
      },
    });

    if (!response.ok) {
      throw new AppError(
        "download_failed",
        `Download failed: the server responded ${response.status} ${response.statusText}.`,
        { detail: `URL: ${parsed.href}`, status: 502 },
      );
    }

    const contentLength = Number(response.headers.get("content-length") ?? 0);
    if (contentLength && contentLength > config.maxUrlSizeMb * 1024 * 1024) {
      throw new AppError(
        "too_large",
        `Remote file is ${(contentLength / (1024 * 1024)).toFixed(0)}MB, above the ${config.maxUrlSizeMb}MB URL limit.`,
        { status: 413 },
      );
    }
    if (!response.body) {
      throw new AppError("download_failed", "Download failed: the server returned no body.");
    }

    const contentType = response.headers.get("content-type");
    const fileNameFromUrl = decodeURIComponent(path.basename(parsed.pathname)) || "video.mp4";
    const targetName = looksSupported(fileNameFromUrl)
      ? fileNameFromUrl
      : `${options.jobId}${contentTypeToExt(contentType)}`;

    await fsp.mkdir(uploadsRoot(), { recursive: true });
    const filePath = path.join(uploadsRoot(), `${options.jobId}-${sanitizeFileName(targetName)}`);
    const writer = createWriteStream(filePath);

    let bytes = 0;
    const nodeStream = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
    nodeStream.on("data", (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > config.maxUrlSizeMb * 1024 * 1024) {
        nodeStream.destroy(new AppError("too_large", `Download exceeded ${config.maxUrlSizeMb}MB limit.`));
        return;
      }
      options.onProgress?.(bytes, contentLength || null);
    });
    await pipeline(nodeStream, writer);

    const size = await fsp.stat(filePath).then((s) => s.size);
    if (size === 0) {
      await fsp.rm(filePath, { force: true });
      throw new AppError("download_failed", "Downloaded file was empty.");
    }
    return { filePath, sizeBytes: size, contentType };
  } catch (error) {
    if (error instanceof AppError) throw error;
    if ((error as Error).name === "AbortError") {
      throw new AppError(
        "download_failed",
        `Download timed out after ${config.urlDownloadTimeoutSec}s.`,
        { detail: `URL: ${parsed.href}` },
      );
    }
    throw new AppError(
      "download_failed",
      `Download failed: ${(error as Error).message}`,
      { detail: `URL: ${parsed.href}` },
    );
  } finally {
    clearTimeout(timeout);
  }
}

function contentTypeToExt(contentType: string | null): string {
  const map: Record<string, string> = {
    "video/mp4": ".mp4",
    "video/quicktime": ".mov",
    "video/webm": ".webm",
    "video/x-matroska": ".mkv",
    "audio/mpeg": ".mp3",
    "audio/mp4": ".m4a",
    "audio/wav": ".wav",
  };
  if (!contentType) return ".mp4";
  return map[contentType.split(";")[0].trim()] ?? ".mp4";
}

/**
 * Probe the source and turn problems into clear, human messages.
 * YouTube/Vimeo pages are detected so the user is not left guessing.
 */
export async function validateSource(
  filePath: string,
  originalName: string,
): Promise<ProbeResult> {
  const probe = await probeVideo(filePath);

  if (probe.durationSec < 3) {
    throw new AppError(
      "unsupported_media",
      `Video is only ${probe.durationSec.toFixed(1)}s long — too short to clip.`,
    );
  }
  if (probe.durationSec > config.maxDurationMinutes * 60) {
    throw new AppError(
      "too_large",
      `Video is ${(probe.durationSec / 60).toFixed(1)} minutes. The limit is ${config.maxDurationMinutes} minutes.`,
      { status: 413 },
    );
  }
  if (!probe.hasAudio) {
    throw new AppError(
      "unsupported_media",
      "This video has no audio track, so there is nothing to transcribe.",
    );
  }

  // Judge by the actual codec, not the extension — an .avi holding H.264 is fine.
  const undecodable = new Set(["vp6", "mpeg2video", "msmpeg4v2", "theo", "indeo3", "flashsv"]);
  if (probe.videoCodec && undecodable.has(probe.videoCodec)) {
    throw new AppError(
      "unsupported_media",
      `Video codec "${probe.videoCodec}" cannot be decoded by this build of FFmpeg.`,
      { detail: "Re-encode the file to H.264 MP4 and try again." },
    );
  }
  void originalName;

  await checkBinaries();
  return probe;
}

/** Friendly guard for the most common URL mistake. */
export function assertDirectMediaUrl(url: string): void {
  const lower = url.toLowerCase();
  const platformHints = ["youtube.com", "youtu.be", "vimeo.com", "tiktok.com", "instagram.com", "facebook.com"];
  if (platformHints.some((hint) => lower.includes(hint))) {
    throw new AppError(
      "download_failed",
      "Social platform links need yt-dlp, which is not installed on this server.",
      {
        detail:
          "Version 1 accepts direct media URLs (a link that ends in .mp4/.mov/.webm) or a file upload from your phone. Set ALLOW_YTDLP=1 on a host where the yt-dlp binary is installed to unlock platform links.",
      },
    );
  }
}
