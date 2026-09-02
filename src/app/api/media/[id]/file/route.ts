import path from "node:path";
import { Readable } from "node:stream";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { mediaAssets } from "@/db/schema";
import { AppError, toErrorPayload } from "@/lib/errors";
import { getObject } from "@/lib/object-storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function asWebStream(body: unknown): ReadableStream<Uint8Array> {
  const candidate = body as { transformToWebStream?: () => ReadableStream<Uint8Array> };
  if (candidate.transformToWebStream) return candidate.transformToWebStream();
  return Readable.toWeb(body as Readable) as unknown as ReadableStream<Uint8Array>;
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const [asset] = await db.select().from(mediaAssets).where(eq(mediaAssets.id, id)).limit(1);
    if (!asset) throw new AppError("not_found", "Media asset not found.", { status: 404 });
    const result = await getObject(asset.objectKey, request.headers.get("range"));
    if (!result.Body) throw new AppError("not_found", "The stored audio file is empty.", { status: 404 });
    const headers = new Headers({
      "Content-Type": result.ContentType || asset.contentType || "application/octet-stream",
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, max-age=3600",
      "Content-Disposition": `inline; filename="${(asset.fileName || path.basename(asset.objectKey)).replace(/"/g, "")}"`,
    });
    if (result.ContentLength !== undefined) headers.set("Content-Length", String(result.ContentLength));
    if (result.ContentRange) headers.set("Content-Range", result.ContentRange);
    return new NextResponse(asWebStream(result.Body), { status: result.ContentRange ? 206 : 200, headers });
  } catch (error) {
    const payload = toErrorPayload(error);
    const upstreamStatus = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    return NextResponse.json({ error: payload.message }, { status: upstreamStatus === 416 ? 416 : error instanceof AppError ? error.status : 500 });
  }
}
