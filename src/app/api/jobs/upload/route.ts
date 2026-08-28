import { NextResponse } from "next/server";
import { config } from "@/lib/config";
import { AppError, toErrorPayload } from "@/lib/errors";
import { sanitizeFileName } from "@/lib/ingest";
import { createJob, ensureRuntime } from "@/lib/jobs";
import { deleteObject, sourceObjectKey, uploadRequestToR2 } from "@/lib/object-storage";
import { normalizeWhisperLanguage } from "@/lib/transcribe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Upload the raw request body directly to durable R2 storage. */
export async function POST(request: Request) {
  let uploadedKey: string | null = null;
  try {
    await ensureRuntime();
    const url = new URL(request.url);
    const rawName = request.headers.get("x-file-name") ?? url.searchParams.get("filename") ?? "video.mp4";
    const fileName = sanitizeFileName(decodeURIComponent(rawName));
    const requestedClips = Number(url.searchParams.get("clips") ?? "") || undefined;
    const maxClipSec = Number(url.searchParams.get("maxClipSec") ?? "") || undefined;
    const subtitles = url.searchParams.get("subtitles") !== "0";
    const language = normalizeWhisperLanguage(url.searchParams.get("language")) ?? null;

    const jobId = `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    uploadedKey = sourceObjectKey(jobId, fileName);
    const sizeBytes = await uploadRequestToR2({
      body: request.body,
      key: uploadedKey,
      maxBytes: config.maxUploadMb * 1024 * 1024,
      contentType: request.headers.get("content-type"),
    });

    await createJob({
      id: jobId,
      sourceType: "upload",
      sourceName: fileName,
      sourceObjectKey: uploadedKey,
      fileSizeBytes: sizeBytes,
      requestedClips,
      maxClipSec,
      subtitlesEnabled: subtitles,
      language,
    });
    return NextResponse.json({ jobId, sizeBytes }, { status: 202 });
  } catch (error) {
    if (uploadedKey) await deleteObject(uploadedKey).catch(() => undefined);
    const payload = toErrorPayload(error);
    return NextResponse.json(
      { error: payload.message, kind: payload.kind, detail: payload.detail },
      { status: error instanceof AppError ? error.status : 500 },
    );
  }
}
