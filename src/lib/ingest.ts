import { createWriteStream } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { config } from "./config";
import { AppError } from "./errors";
import { checkBinaries, probeVideo, type ProbeResult } from "./ffmpeg";
import { uploadsRoot } from "./storage";
import { validatePublicVideoUrl } from "./url-safety";

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
  fileName: string;
  sizeBytes: number;
  contentType: string | null;
  finalUrl: string;
};

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

async function fetchPublicVideo(
  initialUrl: string,
  signal: AbortSignal,
): Promise<{ response: Response; finalUrl: URL }> {
  let current = await validatePublicVideoUrl(initialUrl);
  const redirectLimit = Math.max(0, Math.min(10, Math.round(config.maxUrlRedirects)));
  for (let redirect = 0; redirect <= redirectLimit; redirect += 1) {
    // Re-resolve immediately before every request and validate every redirect.
    current = await validatePublicVideoUrl(current);
    const response = await fetch(current, {
      signal,
      redirect: "manual",
      headers: {
        "User-Agent": "ClipForge/2.0 (+direct-video-downloader)",
        Accept: "video/*,application/octet-stream;q=0.9,*/*;q=0.1",
      },
    });
    if (!REDIRECT_STATUSES.has(response.status)) return { response, finalUrl: current };
    const location = response.headers.get("location");
    await response.body?.cancel().catch(() => undefined);
    if (!location) {
      throw new AppError("download_failed", `Video server returned redirect ${response.status} without a Location header.`, {
        status: 502,
      });
    }
    if (redirect === redirectLimit) {
      throw new AppError("download_failed", `Video URL exceeded the ${redirectLimit}-redirect limit.`, { status: 400 });
    }
    current = await validatePublicVideoUrl(new URL(location, current));
  }
  throw new AppError("download_failed", "Video URL redirect handling failed.");
}

function contentTypeToExt(contentType: string | null): string {
  const map: Record<string, string> = {
    "video/mp4": ".mp4",
    "video/quicktime": ".mov",
    "video/webm": ".webm",
    "video/x-matroska": ".mkv",
    "video/mpeg": ".mpeg",
    "video/mp2t": ".ts",
  };
  if (!contentType) return ".mp4";
  return map[contentType.split(";")[0].trim().toLowerCase()] ?? ".mp4";
}

function assertDirectVideoResponse(response: Response, finalUrl: URL): string | null {
  const raw = response.headers.get("content-type");
  const contentType = raw?.split(";")[0].trim().toLowerCase() || null;
  const hasVideoExtension = looksSupported(decodeURIComponent(path.basename(finalUrl.pathname)));
  const genericBinary = contentType === "application/octet-stream" || contentType === "binary/octet-stream";
  if (contentType?.startsWith("text/") || contentType === "application/json" || contentType === "application/xml") {
    throw new AppError("unsupported_media", `The URL returned ${contentType}, not a video file.`, {
      detail: "Paste a direct public media URL rather than a webpage or API URL.",
      status: 415,
    });
  }
  if (!contentType?.startsWith("video/") && !genericBinary && !hasVideoExtension) {
    throw new AppError("unsupported_media", "The URL did not return a recognizable direct video file.", {
      detail: `Content-Type: ${contentType || "missing"}. Supported direct files include MP4, MOV, MKV, and WEBM.`,
      status: 415,
    });
  }
  return contentType;
}

/** Download a direct public video into the active job's scratch directory. */
export async function downloadFromUrl(options: {
  url: string;
  jobId: string;
  targetDirectory: string;
  onProgress?: (bytes: number, totalBytes: number | null) => void;
}): Promise<DownloadResult> {
  assertDirectMediaUrl(options.url);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.urlDownloadTimeoutSec * 1000);
  let filePath: string | null = null;

  try {
    const { response, finalUrl } = await fetchPublicVideo(options.url, controller.signal);
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new AppError("download_failed", `Video download returned HTTP ${response.status} ${response.statusText}.`, {
        detail: `URL: ${finalUrl.href}`,
        status: 502,
      });
    }
    const contentType = assertDirectVideoResponse(response, finalUrl);
    const contentLength = Number(response.headers.get("content-length") ?? 0);
    const maxBytes = config.maxUrlSizeMb * 1024 * 1024;
    if (contentLength && (!Number.isFinite(contentLength) || contentLength < 0 || contentLength > maxBytes)) {
      await response.body?.cancel().catch(() => undefined);
      throw new AppError(
        "too_large",
        `Remote video is ${Number.isFinite(contentLength) ? `${(contentLength / 1024 / 1024).toFixed(0)}MB` : "an invalid size"}; limit is ${config.maxUrlSizeMb}MB.`,
        { status: 413 },
      );
    }
    if (!response.body) throw new AppError("download_failed", "Video server returned an empty response body.");

    const urlName = decodeURIComponent(path.basename(finalUrl.pathname)) || "video.mp4";
    const fileName = sanitizeFileName(looksSupported(urlName) ? urlName : `${options.jobId}${contentTypeToExt(contentType)}`);
    await fsp.mkdir(options.targetDirectory, { recursive: true });
    filePath = path.join(options.targetDirectory, `source-${fileName}`);

    let bytes = 0;
    const limiter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.byteLength;
        if (bytes > maxBytes) {
          callback(new AppError("too_large", `Video download exceeded the ${config.maxUrlSizeMb}MB limit.`, { status: 413 }));
          return;
        }
        options.onProgress?.(bytes, contentLength || null);
        callback(null, chunk);
      },
    });
    await pipeline(
      Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
      limiter,
      createWriteStream(filePath),
    );
    if (!bytes) throw new AppError("download_failed", "Downloaded video was empty.");
    return { filePath, fileName, sizeBytes: bytes, contentType, finalUrl: finalUrl.href };
  } catch (error) {
    if (filePath) await fsp.rm(filePath, { force: true }).catch(() => undefined);
    if (error instanceof AppError) throw error;
    if ((error as Error).name === "AbortError") {
      throw new AppError("download_failed", `Video download timed out after ${config.urlDownloadTimeoutSec} seconds.`, {
        status: 408,
      });
    }
    throw new AppError("download_failed", `Video download failed: ${(error as Error).message}`, { status: 502 });
  } finally {
    clearTimeout(timeout);
  }
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

/** Reject webpage providers until they have a dedicated source adapter. */
export function assertDirectMediaUrl(value: string): void {
  let hostname = "";
  try {
    hostname = new URL(value).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    throw new AppError("bad_request", "The video URL is not valid.", { status: 400 });
  }
  const pageProviders = ["youtube.com", "youtu.be", "vimeo.com", "tiktok.com", "instagram.com", "facebook.com"];
  if (pageProviders.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`))) {
    throw new AppError("unsupported_media", "This is a webpage URL, not a direct public video file.", {
      detail: "Version 2 supports direct MP4, MOV, MKV, and WEBM URLs first. This provider can be added later through a dedicated downloader adapter.",
      status: 415,
    });
  }
}
