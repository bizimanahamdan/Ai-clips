import { and, eq, inArray } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { jobMediaAssets, jobs, mediaAssets } from "@/db/schema";
import { AppError, toErrorPayload } from "@/lib/errors";
import { ensureRuntime } from "@/lib/jobs";
import { deleteObject } from "@/lib/object-storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await ensureRuntime();
    const { id } = await context.params;
    const [asset] = await db.select().from(mediaAssets).where(eq(mediaAssets.id, id)).limit(1);
    if (!asset) throw new AppError("not_found", "Media asset not found.", { status: 404 });
    const active = await db
      .select({ id: jobs.id })
      .from(jobMediaAssets)
      .innerJoin(jobs, eq(jobMediaAssets.jobId, jobs.id))
      .where(and(eq(jobMediaAssets.assetId, id), inArray(jobs.status, ["queued", "processing"])))
      .limit(1);
    if (active.length) {
      throw new AppError("bad_request", "This asset is being used by an active clip job. Delete it after the job finishes.", { status: 409 });
    }
    await deleteObject(asset.objectKey);
    await db.transaction(async (tx) => {
      await tx.delete(jobMediaAssets).where(eq(jobMediaAssets.assetId, id));
      await tx.delete(mediaAssets).where(eq(mediaAssets.id, id));
    });
    return NextResponse.json({ deleted: true });
  } catch (error) {
    const payload = toErrorPayload(error);
    return NextResponse.json(
      { error: payload.message, kind: payload.kind, detail: payload.detail },
      { status: error instanceof AppError ? error.status : 500 },
    );
  }
}
