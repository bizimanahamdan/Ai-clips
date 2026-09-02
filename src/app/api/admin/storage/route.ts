import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { AppError, toErrorPayload } from "@/lib/errors";
import { listAllObjects, loadStorageReferences } from "@/lib/storage-admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    requireAdmin(request);
    const url = new URL(request.url);
    const query = (url.searchParams.get("q") ?? "").toLowerCase();
    const prefix = url.searchParams.get("prefix") ?? "";
    const status = url.searchParams.get("status") ?? "all";
    const sort = url.searchParams.get("sort") ?? "key";
    const direction = url.searchParams.get("direction") === "desc" ? -1 : 1;
    const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
    const pageSize = Math.max(10, Math.min(200, Number(url.searchParams.get("pageSize")) || 50));
    const [objects, refs] = await Promise.all([listAllObjects(), loadStorageReferences()]);
    const totalSizeBytes = objects.reduce((sum, object) => sum + object.sizeBytes, 0);
    const prefixes = [...new Set(objects.flatMap((object) => {
      const parts = object.key.split("/").slice(0, -1);
      return parts.map((_, index) => `${parts.slice(0, index + 1).join("/")}/`);
    }))].sort();
    const reconciled = objects.map((object) => ({ ...object, references: refs.get(object.key) ?? [], referenced: refs.has(object.key) }));
    const filtered = reconciled.filter((object) =>
      (!query || object.key.toLowerCase().includes(query)) && (!prefix || object.key.startsWith(prefix)) &&
      (status === "all" || (status === "referenced") === object.referenced));
    filtered.sort((a, b) => {
      if (sort === "size") return direction * (a.sizeBytes - b.sizeBytes);
      if (sort === "date") return direction * ((a.lastModified?.getTime() ?? 0) - (b.lastModified?.getTime() ?? 0));
      return direction * a.key.localeCompare(b.key);
    });
    const start = (page - 1) * pageSize;
    return NextResponse.json({
      refreshedAt: new Date().toISOString(), totalObjects: objects.length, totalSizeBytes, prefixes,
      filteredObjects: filtered.length, page, pageSize, pages: Math.max(1, Math.ceil(filtered.length / pageSize)),
      objects: filtered.slice(start, start + pageSize),
    });
  } catch (error) {
    const payload = toErrorPayload(error);
    return NextResponse.json({ error: payload.message, detail: payload.detail }, { status: error instanceof AppError ? error.status : 500 });
  }
}
