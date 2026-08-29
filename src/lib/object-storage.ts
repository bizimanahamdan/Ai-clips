import { createReadStream, createWriteStream } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { config } from "./config";
import { AppError } from "./errors";

let client: S3Client | null = null;

export function r2Configured(): boolean {
  return Boolean(
    config.r2AccountId &&
      config.r2AccessKeyId &&
      config.r2SecretAccessKey &&
      config.r2BucketName &&
      config.r2Endpoint,
  );
}

function r2(): S3Client {
  if (!r2Configured()) {
    throw new AppError("internal", "Cloudflare R2 is not configured.", {
      detail:
        "Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME, and R2_ENDPOINT.",
    });
  }
  client ??= new S3Client({
    region: "auto",
    endpoint: config.r2Endpoint,
    credentials: {
      accessKeyId: config.r2AccessKeyId,
      secretAccessKey: config.r2SecretAccessKey,
    },
  });
  return client;
}

export function sourceObjectKey(jobId: string, fileName: string): string {
  const extension = fileName.match(/\.[a-zA-Z0-9]{1,8}$/)?.[0]?.toLowerCase() || ".mp4";
  return `jobs/${jobId}/source${extension}`;
}

export function clipObjectKey(jobId: string, fileName: string): string {
  return `jobs/${jobId}/clips/${fileName.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
}

export function mediaLibraryObjectKey(assetId: string, fileName: string): string {
  const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-120) || "audio.bin";
  return `media-library/${assetId}/${safeName}`;
}

export function pendingMusicObjectKey(fileName: string): string {
  const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-100) || "music.mp3";
  return `pending-music/${Date.now()}-${Math.random().toString(36).slice(2, 10)}-${safeName}`;
}

async function uploadBody(
  key: string,
  body: Readable,
  contentType: string,
): Promise<void> {
  try {
    const upload = new Upload({
      client: r2(),
      params: {
        Bucket: config.r2BucketName,
        Key: key,
        Body: body,
        ContentType: contentType,
      },
      queueSize: 2,
      partSize: 8 * 1024 * 1024,
      leavePartsOnError: false,
    });
    await upload.done();
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("internal", "Could not upload media to Cloudflare R2.", {
      detail: (error as Error).message,
      status: 502,
    });
  }
}

/** Stream a browser upload directly to R2 without retaining it on app disk. */
export async function uploadRequestToR2(options: {
  body: ReadableStream<Uint8Array> | null;
  key: string;
  maxBytes: number;
  contentType?: string | null;
}): Promise<number> {
  if (!options.body) throw new AppError("bad_request", "Upload body was empty.");
  let bytes = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.byteLength;
      if (bytes > options.maxBytes) {
        callback(
          new AppError(
            "too_large",
            `Upload is larger than the ${Math.round(options.maxBytes / 1024 / 1024)}MB limit.`,
            { status: 413 },
          ),
        );
      } else callback(null, chunk);
    },
  });
  const input = Readable.fromWeb(options.body as Parameters<typeof Readable.fromWeb>[0]);
  input.pipe(limiter);
  try {
    await uploadBody(options.key, limiter, options.contentType || "application/octet-stream");
    if (!bytes) throw new AppError("bad_request", "Uploaded file was empty.");
    return bytes;
  } catch (error) {
    input.destroy();
    limiter.destroy();
    await deleteObject(options.key).catch(() => undefined);
    throw error;
  }
}

export async function uploadFileToR2(
  filePath: string,
  key: string,
  contentType = "application/octet-stream",
): Promise<void> {
  await uploadBody(key, createReadStream(filePath), contentType);
}

export async function downloadObjectToFile(key: string, target: string): Promise<void> {
  try {
    const result = await r2().send(
      new GetObjectCommand({ Bucket: config.r2BucketName, Key: key }),
    );
    if (!result.Body) throw new Error("R2 returned an empty response body");
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await pipeline(result.Body as Readable, createWriteStream(target));
  } catch (error) {
    await fsp.rm(target, { force: true });
    throw new AppError("download_failed", "Could not restore the source video from Cloudflare R2.", {
      detail: (error as Error).message,
      status: 502,
    });
  }
}

export async function getObject(key: string, range?: string | null) {
  return r2().send(
    new GetObjectCommand({
      Bucket: config.r2BucketName,
      Key: key,
      Range: range || undefined,
    }),
  );
}

export async function objectExists(key: string): Promise<boolean> {
  try {
    await r2().send(new HeadObjectCommand({ Bucket: config.r2BucketName, Key: key }));
    return true;
  } catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (status === 404) return false;
    throw error;
  }
}

export async function deleteObject(key: string): Promise<void> {
  await r2().send(new DeleteObjectCommand({ Bucket: config.r2BucketName, Key: key }));
}

export async function deleteObjects(keys: Array<string | null | undefined>): Promise<void> {
  await Promise.all(keys.filter((key): key is string => Boolean(key)).map((key) => deleteObject(key)));
}

/** Remove browser-uploaded music that was never attached to a job. */
export async function deletePendingMusicOlderThan(cutoff: Date, protectedKeys: ReadonlySet<string> = new Set()): Promise<number> {
  let continuationToken: string | undefined;
  let removed = 0;
  do {
    const page = await r2().send(new ListObjectsV2Command({
      Bucket: config.r2BucketName,
      Prefix: "pending-music/",
      ContinuationToken: continuationToken,
    }));
    const stale = (page.Contents ?? []).filter(
      (item): item is typeof item & { Key: string } => Boolean(
        item.Key && item.LastModified && item.LastModified < cutoff && !protectedKeys.has(item.Key),
      ),
    );
    await deleteObjects(stale.map((item) => item.Key));
    removed += stale.length;
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (continuationToken);
  return removed;
}

export async function checkR2(): Promise<{ bucket: string; endpoint: string }> {
  await r2().send(new HeadBucketCommand({ Bucket: config.r2BucketName }));
  return { bucket: config.r2BucketName, endpoint: config.r2Endpoint };
}
