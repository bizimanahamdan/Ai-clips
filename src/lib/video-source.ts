import fsp from "node:fs/promises";
import path from "node:path";
import { config } from "./config";
import { AppError } from "./errors";
import { downloadFromUrl, sanitizeFileName } from "./ingest";
import { deleteObject, downloadObjectToFile, sourceObjectKey, uploadFileToR2 } from "./object-storage";

export type VideoSourceKind = "upload" | "direct_url" | "url";

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
  provider: "upload" | "direct_url";
};

export type AcquisitionProgress = (bytes: number, totalBytes: number | null) => void;

interface VideoSourceProvider {
  readonly kind: AcquiredVideo["provider"];
  supports(sourceType: string): boolean;
  acquire(job: VideoSourceJob, workDir: string, onProgress?: AcquisitionProgress): Promise<AcquiredVideo>;
}

const uploadProvider: VideoSourceProvider = {
  kind: "upload",
  supports: (sourceType) => sourceType === "upload",
  async acquire(job, workDir) {
    if (!job.sourceObjectKey) {
      throw new AppError("unsupported_media", "The uploaded source video is missing from Cloudflare R2. Please upload it again.", {
        status: 410,
      });
    }
    const extension = path.extname(job.sourceName) || ".mp4";
    const localPath = path.join(workDir, `source${extension}`);
    await downloadObjectToFile(job.sourceObjectKey, localPath);
    const { size } = await fsp.stat(localPath);
    return {
      localPath,
      fileName: sanitizeFileName(job.sourceName),
      sizeBytes: size,
      contentType: null,
      durableObjectKey: job.sourceObjectKey,
      provider: "upload",
    };
  },
};

const directUrlProvider: VideoSourceProvider = {
  kind: "direct_url",
  // `url` is retained for jobs created before the V2 source name was added.
  supports: (sourceType) => sourceType === "direct_url" || sourceType === "url",
  async acquire(job, workDir, onProgress) {
    if (config.persistUrlSources && job.sourceObjectKey) {
      const extension = path.extname(job.sourceName) || ".mp4";
      const localPath = path.join(workDir, `source${extension}`);
      await downloadObjectToFile(job.sourceObjectKey, localPath);
      const { size } = await fsp.stat(localPath);
      return {
        localPath,
        fileName: sanitizeFileName(job.sourceName),
        sizeBytes: size,
        contentType: null,
        durableObjectKey: job.sourceObjectKey,
        provider: "direct_url",
      };
    }
    if (!job.sourceUrl) throw new AppError("bad_request", "This direct URL job has no source URL.");
    const downloaded = await downloadFromUrl({
      url: job.sourceUrl,
      jobId: job.id,
      targetDirectory: workDir,
      onProgress,
    });
    let durableObjectKey: string | null = null;
    if (config.persistUrlSources) {
      durableObjectKey = job.sourceObjectKey || sourceObjectKey(job.id, downloaded.fileName);
      await uploadFileToR2(downloaded.filePath, durableObjectKey, downloaded.contentType || "application/octet-stream");
    } else if (job.sourceObjectKey) {
      // Remove a source retained by an older deployment after reacquisition.
      await deleteObject(job.sourceObjectKey).catch(() => undefined);
    }
    return {
      localPath: downloaded.filePath,
      fileName: downloaded.fileName,
      sizeBytes: downloaded.sizeBytes,
      contentType: downloaded.contentType,
      durableObjectKey,
      provider: "direct_url",
    };
  },
};

/** Add future provider adapters here; the processing pipeline remains unchanged. */
const providers: VideoSourceProvider[] = [uploadProvider, directUrlProvider];

export async function acquireVideoSource(
  job: VideoSourceJob,
  workDir: string,
  onProgress?: AcquisitionProgress,
): Promise<AcquiredVideo> {
  const provider = providers.find((candidate) => candidate.supports(job.sourceType));
  if (!provider) {
    throw new AppError("unsupported_media", `Unsupported video source provider: ${job.sourceType}.`, {
      detail: "Supported sources are file uploads and direct public video URLs.",
      status: 400,
    });
  }
  return provider.acquire(job, workDir, onProgress);
}
