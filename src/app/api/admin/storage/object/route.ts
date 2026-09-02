import path from "node:path";
import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { AppError, toErrorPayload } from "@/lib/errors";
import { deleteObject, getObject, headObject } from "@/lib/object-storage";
import { loadStorageReferences } from "@/lib/storage-admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function webStream(body: unknown): ReadableStream<Uint8Array> {
  const candidate = body as { transformToWebStream?: () => ReadableStream<Uint8Array> };
  return candidate.transformToWebStream ? candidate.transformToWebStream() : Readable.toWeb(body as Readable) as unknown as ReadableStream<Uint8Array>;
}

export async function GET(request: Request) {
  try {
    requireAdmin(request);
    const url = new URL(request.url);
    const key = url.searchParams.get("key");
    if (!key) throw new AppError("bad_request", "An exact object key is required.", { status: 400 });
    if (url.searchParams.get("download") !== "1") {
      const [head, refs] = await Promise.all([headObject(key), loadStorageReferences()]);
      if (!head.exists) throw new AppError("not_found", "That exact R2 object no longer exists.", { status: 404 });
      return NextResponse.json({ ...head, references: refs.get(key) ?? [], referenced: refs.has(key) });
    }
    const result = await getObject(key);
    if (!result.Body) throw new AppError("not_found", "Cloudflare R2 returned an empty object.", { status: 404 });
    const headers = new Headers({
      "Content-Type": result.ContentType || "application/octet-stream",
      "Content-Disposition": `attachment; filename="${path.basename(key).replace(/"/g, "")}"`,
      "Cache-Control": "private, no-store",
    });
    if (result.ContentLength !== undefined) headers.set("Content-Length", String(result.ContentLength));
    return new NextResponse(webStream(result.Body), { headers });
  } catch (error) {
    const payload = toErrorPayload(error);
    return NextResponse.json({ error: payload.message }, { status: error instanceof AppError ? error.status : 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    requireAdmin(request);
    const body = await request.json().catch(() => ({})) as { key?: string; confirmation?: string };
    const key = body.key ?? "";
    if (!key) throw new AppError("bad_request", "An exact object key is required.", { status: 400 });
    const refs = (await loadStorageReferences()).get(key) ?? [];
    const expected = refs.length ? `DELETE REFERENCED ${key}` : `DELETE ${key}`;
    if (body.confirmation !== expected) {
      throw new AppError("bad_request", refs.length
        ? `This object has ${refs.length} database reference(s). Type DELETE REFERENCED followed by the exact key to force deletion; database references will be preserved.`
        : "Type DELETE followed by the exact object key to confirm.", { status: refs.length ? 409 : 400 });
    }
    await deleteObject(key);
    return NextResponse.json({ deleted: true, key, referencesPreserved: refs.length });
  } catch (error) {
    const payload = toErrorPayload(error);
    return NextResponse.json({ error: payload.message, detail: payload.detail }, { status: error instanceof AppError ? error.status : 500 });
  }
}
