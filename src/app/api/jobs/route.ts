import { NextResponse } from "next/server";
import { AppError, toErrorPayload } from "@/lib/errors";
import { assertDirectMediaUrl } from "@/lib/ingest";
import { createJob, ensureRuntime, listJobs } from "@/lib/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET() {
  await ensureRuntime();
  const jobs = await listJobs(12);
  return NextResponse.json({ jobs });
}

/** Create a job from a direct media URL. */
export async function POST(request: Request) {
  try {
    await ensureRuntime();
    const body = (await request.json().catch(() => ({}))) as {
      url?: string;
      requestedClips?: number;
      maxClipSec?: number;
      subtitlesEnabled?: boolean;
      language?: string;
    };

    const url = (body.url ?? "").trim();
    if (!url) throw new AppError("bad_request", "Paste a video URL first.", { status: 400 });
    if (url.length > 2048) throw new AppError("bad_request", "That URL is too long.", { status: 400 });

    assertDirectMediaUrl(url);

    const fileName = decodeURIComponent(url.split("?")[0].split("/").pop() || "video.mp4");
    const jobId = await createJob({
      sourceType: "url",
      sourceName: fileName,
      sourceUrl: url,
      requestedClips: body.requestedClips,
      maxClipSec: body.maxClipSec,
      subtitlesEnabled: body.subtitlesEnabled,
      language: body.language?.trim() || null,
    });

    return NextResponse.json({ jobId }, { status: 202 });
  } catch (error) {
    const payload = toErrorPayload(error);
    return NextResponse.json(
      { error: payload.message, kind: payload.kind, detail: payload.detail },
      { status: error instanceof AppError ? error.status : 500 },
    );
  }
}
