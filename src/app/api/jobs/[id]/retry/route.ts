import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { jobEvents, jobs } from "@/db/schema";
import { AppError, toErrorPayload } from "@/lib/errors";
import { ensureRuntime } from "@/lib/jobs";
import { config } from "@/lib/config";
import { headObject } from "@/lib/object-storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Re-run a failed or partially failed job from the beginning. */
export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await ensureRuntime();
    const { id } = await context.params;
    const [job] = await db.select().from(jobs).where(eq(jobs.id, id)).limit(1);
    if (!job) throw new AppError("not_found", `Job ${id} not found.`, { status: 404 });
    if (job.status === "queued" || job.status === "processing") {
      return NextResponse.json({ jobId: id, alreadyRunning: true });
    }
    if (job.sourceType === "upload") {
      if (!job.sourceObjectKey) {
        throw new AppError("unsupported_media", "This job has no persisted sourceObjectKey. Please upload the video again.", { status: 410 });
      }
      const source = await headObject(job.sourceObjectKey);
      console.info(`[R2 verify-before-download] bucket=${config.r2BucketName} key=${job.sourceObjectKey} job=${id} exists=${source.exists} action=retry-check`);
      if (!source.exists) {
        throw new AppError(
          "unsupported_media",
          "The original upload no longer exists at this job's exact Cloudflare R2 key. Please upload it again.",
          { detail: `job=${id} sourceObjectKey=${job.sourceObjectKey}`, status: 410 },
        );
      }
    }

    await db
      .update(jobs)
      .set({
        status: "queued",
        stage: "queued",
        stageDetail: "Queued to resume from saved checkpoints",
        progress: 0,
        error: null,
        finishedAt: null,
        expiresAt: new Date(Date.now() + config.retentionHours * 3600 * 1000),
        updatedAt: new Date(),
      })
      .where(eq(jobs.id, id));
    await db.insert(jobEvents).values({
      jobId: id,
      stage: "queued",
      level: "warn",
      message: "Retry requested — saved source, probe, transcript, chunk analysis, selection, and completed renders will be reused.",
    });

    const { enqueueJob } = await import("@/lib/jobs");
    enqueueJob(id);

    return NextResponse.json({ jobId: id, status: "queued" }, { status: 202 });
  } catch (error) {
    const payload = toErrorPayload(error);
    return NextResponse.json(
      { error: payload.message, kind: payload.kind },
      { status: error instanceof AppError ? error.status : 500 },
    );
  }
}
