import { NextResponse } from "next/server";
import { config } from "@/lib/config";
import { AppError, toErrorPayload } from "@/lib/errors";
import { sanitizeFileName, saveUploadStream } from "@/lib/ingest";
import { createJob, ensureRuntime } from "@/lib/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Uploads are sent as a raw binary body (not multipart) so the server can pipe
 * the stream straight to disk without buffering the whole video in memory.
 */
export async function POST(request: Request) {
  try {
    await ensureRuntime();
    const url = new URL(request.url);
    const rawName = request.headers.get("x-file-name") ?? url.searchParams.get("filename") ?? "video.mp4";
    const fileName = sanitizeFileName(decodeURIComponent(rawName));

    const requestedClips = Number(url.searchParams.get("clips") ?? "") || undefined;
    const maxClipSec = Number(url.searchParams.get("maxClipSec") ?? "") || undefined;
    const subtitles = url.searchParams.get("subtitles") !== "0";
    const language = url.searchParams.get("language")?.trim() || null;

    const { filePath, sizeBytes } = await saveUploadStream({
      body: request.body,
      fileName,
      maxBytes: config.maxUploadMb * 1024 * 1024,
    });

    const jobId = await createJob({
      sourceType: "upload",
      sourceName: fileName,
      filePath,
      fileSizeBytes: sizeBytes,
      requestedClips,
      maxClipSec,
      subtitlesEnabled: subtitles,
      language,
    });

    return NextResponse.json({ jobId, sizeBytes }, { status: 202 });
  } catch (error) {
    const payload = toErrorPayload(error);
    return NextResponse.json(
      { error: payload.message, kind: payload.kind, detail: payload.detail },
      { status: error instanceof AppError ? error.status : 500 },
    );
  }
}
