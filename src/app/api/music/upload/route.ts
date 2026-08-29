import path from "node:path";
import { NextResponse } from "next/server";
import { config } from "@/lib/config";
import { AppError, toErrorPayload } from "@/lib/errors";
import { sanitizeFileName } from "@/lib/ingest";
import { ensureRuntime } from "@/lib/jobs";
import { deleteObject, pendingMusicObjectKey, uploadRequestToR2 } from "@/lib/object-storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 180;

const MUSIC_EXTENSIONS = new Set([".mp3", ".wav", ".m4a", ".aac"]);

export async function POST(request: Request) {
  let objectKey: string | null = null;
  try {
    await ensureRuntime();
    const rawName = request.headers.get("x-file-name") || "music.mp3";
    const fileName = sanitizeFileName(decodeURIComponent(rawName));
    if (!MUSIC_EXTENSIONS.has(path.extname(fileName).toLowerCase())) {
      throw new AppError("unsupported_media", "Background music must be MP3, WAV, M4A, or AAC.", { status: 415 });
    }
    const contentType = request.headers.get("content-type");
    if (contentType && !contentType.startsWith("audio/") && contentType !== "application/octet-stream") {
      throw new AppError("unsupported_media", `Background music has unsupported Content-Type: ${contentType}.`, { status: 415 });
    }
    objectKey = pendingMusicObjectKey(fileName);
    const sizeBytes = await uploadRequestToR2({
      body: request.body,
      key: objectKey,
      maxBytes: config.maxMusicUploadMb * 1024 * 1024,
      contentType: contentType || "application/octet-stream",
    });
    return NextResponse.json({ objectKey, fileName, sizeBytes }, { status: 201 });
  } catch (error) {
    if (objectKey) await deleteObject(objectKey).catch(() => undefined);
    const payload = toErrorPayload(error);
    return NextResponse.json(
      { error: payload.message, detail: payload.detail, kind: payload.kind },
      { status: error instanceof AppError ? error.status : 500 },
    );
  }
}

export async function DELETE(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as { objectKey?: string };
    if (!body.objectKey?.startsWith("pending-music/")) {
      throw new AppError("bad_request", "Invalid pending music object key.", { status: 400 });
    }
    await deleteObject(body.objectKey);
    return NextResponse.json({ deleted: true });
  } catch (error) {
    const payload = toErrorPayload(error);
    return NextResponse.json({ error: payload.message }, { status: error instanceof AppError ? error.status : 500 });
  }
}
