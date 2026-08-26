import { createReadStream } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { clips } from "@/db/schema";
import { AppError, toErrorPayload } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function toWebStream(nodeStream: Readable): ReadableStream<Uint8Array> {
  return Readable.toWeb(nodeStream) as unknown as ReadableStream<Uint8Array>;
}

/**
 * Serves a rendered clip from temporary storage.
 * Supports HTTP Range so <video> scrubbing works on Android Chrome.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const [clip] = await db.select().from(clips).where(eq(clips.id, id)).limit(1);
    if (!clip) throw new AppError("not_found", "Clip not found (it may have been cleaned up).", { status: 404 });
    if (clip.status !== "ready" || !clip.filePath) {
      throw new AppError("not_found", `Clip is not ready yet (status: ${clip.status}).`, { status: 409 });
    }

    const stat = await fsp.stat(clip.filePath).catch(() => null);
    if (!stat) {
      throw new AppError(
        "not_found",
        "The clip file has already been removed from temporary storage. Re-run the job.",
        { status: 410 },
      );
    }

    const url = new URL(request.url);
    const download = url.searchParams.get("download") === "1";
    const fileName = clip.fileName || path.basename(clip.filePath);
    const disposition = `${download ? "attachment" : "inline"}; filename="${fileName.replace(/"/g, "")}"`;
    const headers = new Headers({
      "Content-Type": "video/mp4",
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, max-age=3600",
      "Content-Disposition": disposition,
    });

    const range = request.headers.get("range");
    if (range) {
      const match = range.match(/bytes=(\d*)-(\d*)/);
      if (match) {
        const start = match[1] ? Number(match[1]) : 0;
        const end = match[2] ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1;
        if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= stat.size) {
          return new NextResponse(null, {
            status: 416,
            headers: { "Content-Range": `bytes */${stat.size}` },
          });
        }
        headers.set("Content-Range", `bytes ${start}-${end}/${stat.size}`);
        headers.set("Content-Length", String(end - start + 1));
        return new NextResponse(toWebStream(createReadStream(clip.filePath, { start, end })), {
          status: 206,
          headers,
        });
      }
    }

    headers.set("Content-Length", String(stat.size));
    return new NextResponse(toWebStream(createReadStream(clip.filePath)), { status: 200, headers });
  } catch (error) {
    const payload = toErrorPayload(error);
    return NextResponse.json(
      { error: payload.message, kind: payload.kind },
      { status: error instanceof AppError ? error.status : 500 },
    );
  }
}
