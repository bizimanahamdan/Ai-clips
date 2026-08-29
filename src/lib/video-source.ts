import fsp from "node:fs/promises";
import path from "node:path";
import { config } from "./config";
import { AppError } from "./errors";
import { downloadFromUrl, sanitizeFileName } from "./ingest";
import { deleteObject, downloadObjectToFile, sourceObjectKey, uploadFileToR2 } from "./object-storage";

export type VideoSourceKind = "upload" | "direct_url" | "dropbox" | "google_drive" | "url";
export type VideoSourceProviderName = "upload" | "direct_url" | "dropbox" | "google_drive";

export type VideoSourceJob = {
  id: string;
  sourceType: string;
  sourceName: string;
  sourceUrl: string | null;
  sourceObjectKey: string | null;
};

export type AcquiredVideo = {
  localPath: string;
  fileName: string;
  sizeBytes: number;
  contentType: string | null;
  durableObjectKey: string | null;
  provider: VideoSourceProviderName;
};

export type AcquisitionProgress = (bytes: number, totalBytes: number | null) => void;

/**
 * A provider adapter only resolves an authorized share URL into a downloadable
 * public URL. Every resulting URL still goes through the shared SSRF-safe,
 * bounded streaming downloader; downstream probing/rendering is unchanged.
 */
export interface VideoSourceAdapter {
  readonly kind: VideoSourceProviderName;
  supports(sourceType: string): boolean;
  acquire(job: VideoSourceJob, workDir: string, onProgress?: AcquisitionProgress): Promise<AcquiredVideo>;
}

function hostnameMatches(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

const unsupportedWebProviders: Array<[string, string]> = [
  ["youtube.com", "YouTube"],
  ["youtu.be", "YouTube"],
  ["vimeo.com", "Vimeo"],
  ["tiktok.com", "TikTok"],
  ["instagram.com", "Instagram"],
  ["facebook.com", "Facebook"],
  ["fb.watch", "Facebook"],
  ["x.com", "X/Twitter"],
  ["twitter.com", "X/Twitter"],
];

/** Detect the adapter before job creation, so webpage URLs never reach FFmpeg. */
export function classifyVideoSourceUrl(value: string): Exclude<VideoSourceKind, "upload" | "url"> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AppError("bad_request", "The video URL is not valid.", { status: 400 });
  }
  const hostname = url.hostname.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
  if (hostnameMatches(hostname, "dropbox.com") || hostnameMatches(hostname, "dropboxusercontent.com")) {
    return "dropbox";
  }
  if (hostnameMatches(hostname, "drive.google.com") || hostnameMatches(hostname, "drive.usercontent.google.com")) {
    googleDriveDownloadUrl(url.href);
    return "google_drive";
  }
  const unsupported = unsupportedWebProviders.find(([domain]) => hostnameMatches(hostname, domain));
  if (unsupported) {
    throw new AppError("unsupported_media", `${unsupported[1]} webpage imports are not supported.`, {
      detail: "Use an authorized public Google Drive or Dropbox share link, a direct MP4/MOV/MKV/WEBM URL, or upload the file.",
      status: 415,
    });
  }
  return "direct_url";
}

function dropboxDownloadUrl(value: string): string {
  const url = new URL(value);
  if (!hostnameMatches(url.hostname.toLowerCase().replace(/^www\./, ""), "dropbox.com") &&
      !hostnameMatches(url.hostname.toLowerCase(), "dropboxusercontent.com")) {
    throw new AppError("bad_request", "This is not a valid Dropbox share URL.", { status: 400 });
  }
  // Dropbox's documented raw-download form keeps its signed path/query while
  // returning media bytes rather than the preview webpage.
  url.searchParams.delete("dl");
  url.searchParams.set("raw", "1");
  return url.href;
}

function googleDriveDownloadUrl(value: string): string {
  const url = new URL(value);
  const pathMatch = url.pathname.match(/\/file\/d\/([^/]+)/);
  const id = pathMatch?.[1] || url.searchParams.get("id");
  if (!id || !/^[a-zA-Z0-9_-]{10,}$/.test(id)) {
    throw new AppError("bad_request", "The Google Drive link does not contain a valid file ID.", {
      detail: "Use a public file share link such as https://drive.google.com/file/d/FILE_ID/view.",
      status: 400,
    });
  }
  return `https://drive.usercontent.google.com/download?id=${encodeURIComponent(id)}&export=download&confirm=t`;
}

async function acquireRemote(
  job: VideoSourceJob,
  workDir: string,
  provider: Exclude<VideoSourceProviderName, "upload">,
  resolveUrl: (value: string) => string,
  onProgress?: AcquisitionProgress,
): Promise<AcquiredVideo> {
  if (config.persistUrlSources && job.sourceObjectKey) {
    const extension = path.extname(job.sourceName) || ".mp4";
    const localPath = path.join(workDir, `source${extension}`);
    await downloadObjectToFile(job.sourceObjectKey, localPath);
    const { size } = await fsp.stat(localPath);
    return { localPath, fileName: sanitizeFileName(job.sourceName), sizeBytes: size, contentType: null, durableObjectKey: job.sourceObjectKey, provider };
  }
  if (!job.sourceUrl) throw new AppError("bad_request", `This ${provider.replace("_", " ")} job has no source URL.`);
  const downloaded = await downloadFromUrl({
    url: resolveUrl(job.sourceUrl),
    jobId: job.id,
    targetDirectory: workDir,
    onProgress,
  });
  let durableObjectKey: string | null = null;
  if (config.persistUrlSources) {
    durableObjectKey = job.sourceObjectKey || sourceObjectKey(job.id, downloaded.fileName);
    await uploadFileToR2(downloaded.filePath, durableObjectKey, downloaded.contentType || "application/octet-stream");
  } else if (job.sourceObjectKey) {
    await deleteObject(job.sourceObjectKey).catch(() => undefined);
  }
  return {
    localPath: downloaded.filePath,
    fileName: downloaded.fileName,
    sizeBytes: downloaded.sizeBytes,
    contentType: downloaded.contentType,
    durableObjectKey,
    provider,
  };
}

const uploadAdapter: VideoSourceAdapter = {
  kind: "upload",
  supports: (sourceType) => sourceType === "upload",
  async acquire(job, workDir) {
    if (!job.sourceObjectKey) {
      throw new AppError("unsupported_media", "The uploaded source video is missing from Cloudflare R2. Please upload it again.", { status: 410 });
    }
    const extension = path.extname(job.sourceName) || ".mp4";
    const localPath = path.join(workDir, `source${extension}`);
    await downloadObjectToFile(job.sourceObjectKey, localPath);
    const { size } = await fsp.stat(localPath);
    return { localPath, fileName: sanitizeFileName(job.sourceName), sizeBytes: size, contentType: null, durableObjectKey: job.sourceObjectKey, provider: "upload" };
  },
};

const directUrlAdapter: VideoSourceAdapter = {
  kind: "direct_url",
  supports: (sourceType) => sourceType === "direct_url" || sourceType === "url",
  acquire: (job, workDir, onProgress) => acquireRemote(job, workDir, "direct_url", (url) => url, onProgress),
};

const dropboxAdapter: VideoSourceAdapter = {
  kind: "dropbox",
  supports: (sourceType) => sourceType === "dropbox",
  acquire: (job, workDir, onProgress) => acquireRemote(job, workDir, "dropbox", dropboxDownloadUrl, onProgress),
};

const googleDriveAdapter: VideoSourceAdapter = {
  kind: "google_drive",
  supports: (sourceType) => sourceType === "google_drive",
  acquire: (job, workDir, onProgress) => acquireRemote(job, workDir, "google_drive", googleDriveDownloadUrl, onProgress),
};

/** Register future authorized provider adapters here. */
export const videoSourceAdapters: readonly VideoSourceAdapter[] = [
  uploadAdapter,
  dropboxAdapter,
  googleDriveAdapter,
  directUrlAdapter,
];

export async function acquireVideoSource(
  job: VideoSourceJob,
  workDir: string,
  onProgress?: AcquisitionProgress,
): Promise<AcquiredVideo> {
  const adapter = videoSourceAdapters.find((candidate) => candidate.supports(job.sourceType));
  if (!adapter) {
    throw new AppError("unsupported_media", `Unsupported video source provider: ${job.sourceType}.`, {
      detail: "Supported sources are uploads, direct public video URLs, public Dropbox links, and public Google Drive file links.",
      status: 400,
    });
  }
  try {
    return await adapter.acquire(job, workDir, onProgress);
  } catch (error) {
    if (error instanceof AppError && (adapter.kind === "dropbox" || adapter.kind === "google_drive")) {
      throw new AppError(error.kind, `${adapter.kind === "dropbox" ? "Dropbox" : "Google Drive"} import failed: ${error.message}`, {
        detail: error.detail || "Confirm the file is publicly accessible to anyone with the link and is a supported video file.",
        status: error.status,
      });
    }
    throw error;
  }
}
