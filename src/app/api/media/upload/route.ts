import fsp from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { mediaAssets } from "@/db/schema";
import { config } from "@/lib/config";
import { AppError, toErrorPayload } from "@/lib/errors";
import { analyzeMusicEnergy, probeVideo } from "@/lib/ffmpeg";
import { sanitizeFileName } from "@/lib/ingest";
import { mediaApiAsset, normalizeCategory, normalizeTags } from "@/lib/media-library";
import { ensureRuntime } from "@/lib/jobs";
import { deleteObject, downloadObjectToFile, mediaLibraryObjectKey, uploadRequestToR2 } from "@/lib/object-storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".m4a", ".aac", ".ogg"]);

export async function POST(request: Request) {
  let objectKey: string | null = null;
  let tempDir: string | null = null;
  try {
    await ensureRuntime();
    const url = new URL(request.url);
    const category = normalizeCategory(url.searchParams.get("category"));
    const rawFileName = request.headers.get("x-file-name") || "audio.mp3";
    const fileName = sanitizeFileName(decodeURIComponent(rawFileName));
    const extension = path.extname(fileName).toLowerCase();
    if (!AUDIO_EXTENSIONS.has(extension)) {
      throw new AppError("unsupported_media", "Library audio must be MP3, WAV, M4A, AAC, or OGG.", { status: 415 });
    }
    const contentType = request.headers.get("content-type") || "application/octet-stream";
    if (!contentType.startsWith("audio/") && contentType !== "application/octet-stream") {
      throw new AppError("unsupported_media", `Unsupported audio Content-Type: ${contentType}.`, { status: 415 });
    }
    const tags = normalizeTags(url.searchParams.get("tags"));
    const displayName = (url.searchParams.get("name")?.trim() || path.basename(fileName, extension)).slice(0, 120);
    const id = `asset_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
    objectKey = mediaLibraryObjectKey(id, fileName);
    const fileSizeBytes = await uploadRequestToR2({
      body: request.body,
      key: objectKey,
      maxBytes: config.maxMusicUploadMb * 1024 * 1024,
      contentType,
    });

    await fsp.mkdir(config.storageDir, { recursive: true });
    tempDir = await fsp.mkdtemp(path.join(config.storageDir, "media-upload-"));
    const localPath = path.join(tempDir, fileName);
    await downloadObjectToFile(objectKey, localPath);
    const probe = await probeVideo(localPath);
    if (!probe.hasAudio) throw new AppError("unsupported_media", "This asset has no decodable audio stream.", { status: 415 });
    if (probe.durationSec > config.maxMusicDurationMinutes * 60) {
      throw new AppError("too_large", `Audio is longer than ${config.maxMusicDurationMinutes} minutes.`, { status: 413 });
    }
    const analysis = category === "music"
      ? await analyzeMusicEnergy(localPath).catch(() => ({
          durationSec: probe.durationSec,
          averageDb: null,
          peakTimesSec: [],
          estimatedBpm: null,
          vibe: "unknown",
        }))
      : null;

    const [created] = await db.insert(mediaAssets).values({
      id,
      category,
      name: displayName,
      fileName,
      contentType,
      objectKey,
      fileSizeBytes,
      durationSec: probe.durationSec,
      tags,
      analysis,
    }).returning();
    objectKey = null;
    return NextResponse.json({ asset: mediaApiAsset(created) }, { status: 201 });
  } catch (error) {
    if (objectKey) await deleteObject(objectKey).catch(() => undefined);
    const payload = toErrorPayload(error);
    return NextResponse.json(
      { error: payload.message, kind: payload.kind, detail: payload.detail },
      { status: error instanceof AppError ? error.status : 500 },
    );
  } finally {
    if (tempDir) await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
