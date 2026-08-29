import path from "node:path";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { mediaAssets } from "@/db/schema";
import { config } from "@/lib/config";
import { AppError, toErrorPayload } from "@/lib/errors";
import { sanitizeFileName } from "@/lib/ingest";
import { mediaApiAsset, normalizeCategory, normalizeTags } from "@/lib/media-library";
import { deleteObject, mediaLibraryObjectKey, uploadRequestToR2 } from "@/lib/object-storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".m4a", ".aac", ".ogg"]);

export async function POST(request: Request) {
  console.info("[media-upload] request started");
  let objectKey: string | null = null;
  try {
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

    // Keep this request intentionally I/O-only. Audio probing and full-file
    // FFmpeg analysis are too expensive for the 0.1 CPU / 512 MB instance.
    console.info("[media-upload] uploading to R2");
    const fileSizeBytes = await uploadRequestToR2({
      body: request.body,
      key: objectKey,
      maxBytes: config.maxMusicUploadMb * 1024 * 1024,
      contentType,
    });
    console.info("[media-upload] R2 upload complete");

    const [created] = await db.insert(mediaAssets).values({
      id,
      category,
      name: displayName,
      fileName,
      contentType,
      objectKey,
      fileSizeBytes,
      durationSec: null,
      tags,
      analysis: null,
    }).returning();
    console.info("[media-upload] database record saved");
    objectKey = null;
    console.info("[media-upload] completed");
    return NextResponse.json({ asset: mediaApiAsset(created) }, { status: 201 });
  } catch (error) {
    if (objectKey) await deleteObject(objectKey).catch(() => undefined);
    const payload = toErrorPayload(error);
    console.error(`[media-upload] failed: ${payload.message}${payload.detail ? ` — ${payload.detail}` : ""}`);
    return NextResponse.json(
      { error: payload.message, kind: payload.kind, detail: payload.detail },
      { status: error instanceof AppError ? error.status : 500 },
    );
  }
}
