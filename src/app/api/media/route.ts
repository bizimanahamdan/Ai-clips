import { desc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { mediaAssets } from "@/db/schema";
import { AppError, toErrorPayload } from "@/lib/errors";
import { ensureRuntime } from "@/lib/jobs";
import { mediaApiAsset, normalizeCategory } from "@/lib/media-library";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    await ensureRuntime();
    const url = new URL(request.url);
    const rawCategory = url.searchParams.get("category");
    const category = rawCategory ? normalizeCategory(rawCategory) : null;
    const search = url.searchParams.get("q")?.trim().toLowerCase() || "";
    const tag = url.searchParams.get("tag")?.trim().toLowerCase() || "";
    const rows = category
      ? await db.select().from(mediaAssets).where(eq(mediaAssets.category, category)).orderBy(desc(mediaAssets.createdAt)).limit(500)
      : await db.select().from(mediaAssets).orderBy(desc(mediaAssets.createdAt)).limit(500);
    const filtered = rows.filter((asset) => {
      const tags = asset.tags ?? [];
      return (!search || asset.name.toLowerCase().includes(search) || asset.fileName.toLowerCase().includes(search) || tags.some((item) => item.toLowerCase().includes(search))) &&
        (!tag || tags.some((item) => item.toLowerCase() === tag));
    });
    return NextResponse.json({ assets: filtered.map(mediaApiAsset) });
  } catch (error) {
    const payload = toErrorPayload(error);
    return NextResponse.json(
      { error: payload.message, kind: payload.kind, detail: payload.detail },
      { status: error instanceof AppError ? error.status : 500 },
    );
  }
}
