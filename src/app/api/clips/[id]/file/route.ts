import path from "node:path";
import { Readable } from "node:stream";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { clips } from "@/db/schema";
import { AppError, toErrorPayload } from "@/lib/errors";
import { getObject } from "@/lib/object-storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function asWebStream(body: unknown): ReadableStream<Uint8Array> {
  const candidate = body as { transformToWebStream?: () => ReadableStream<Uint8Array> };
  if (candidate.transformToWebStream) return candidate.transformToWebStream();
  return Readable.toWeb(body as Readable) as unknown as ReadableStream<Uint8Array>;
}

/** Proxy a durable R2 object while preserving Range support for mobile video. */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const [clip] = await db.select().from(clips).where(eq(clips.id, id)).limit(1);
    if (!clip) throw new AppError("not_found", "Clip not found (it may have expired).", { status: 404 });
    if (clip.status !== "ready" || !clip.objectKey) {
      throw new AppError("not_found", `Clip is not ready yet (status: ${clip.status}).`, { status: 409 });
    }

    const result = await getObject(clip.objectKey, request.headers.get("range"));
    if (!result.Body) throw new AppError("not_found", "Cloudflare R2 returned an empty clip.", { status: 404 });
    const url = new URL(request.url);
    const download = url.searchParams.get("download") === "1";
    const fileName = clip.fileName || path.basename(clip.objectKey);
    const headers = new Headers({
      "Content-Type": result.ContentType || "video/mp4",
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, max-age=3600",
      "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${fileName.replace(/"/g, "")}"`,
    });
    if (result.ContentLength !== undefined) headers.set("Content-Length", String(result.ContentLength));
    if (result.ContentRange) headers.set("Content-Range", result.ContentRange);
    return new NextResponse(asWebStream(result.Body), {
      status: result.ContentRange ? 206 : 200,
      headers,
    });
  } catch (error) {
    const payload = toErrorPayload(error);
    const upstreamStatus = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    return NextResponse.json(
      { error: payload.message, kind: payload.kind },
      { status: upstreamStatus === 416 ? 416 : error instanceof AppError ? error.status : 500 },
    );
  }
}
