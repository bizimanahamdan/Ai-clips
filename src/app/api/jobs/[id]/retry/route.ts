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

/** Resume a failed or partial job from its earliest incomplete checkpoint. */
export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await ensureRuntime();
    const { id } = await context.params;
    const [job] = await db.select().from(jobs).where(eq(jobs.id, id)).limit(1);
    if (!job) throw new AppError("not_found", `Job ${id} not found.`, { status: 404 });
    if (job.status === "queued" || job.status === "processing") {
      return NextResponse.json({ jobId: id, alreadyRunning: true });
    }
    if (job.status === "cleanup_pending") {
      throw new AppError("bad_request", "This completed job is currently being removed by retention cleanup.", { status: 409 });
    }
    if (!job.sourceObjectKey && job.sourceType === "upload") {
      throw new AppError("source_object_missing", "This upload job has no persisted sourceObjectKey.", {
        detail: `job=${id} stage=retry`,
        status: 410,
      });
    }
    // A non-null size means acquisition completed and the persisted key must
    // exist. Do not hide durable data loss by re-uploading or redownloading.
    if (job.sourceObjectKey && job.fileSizeBytes !== null) {
      const source = await headObject(job.sourceObjectKey);
      console.info(`[R2 source check] bucket=${config.r2BucketName} key=${job.sourceObjectKey} job=${id} stage=retry exists=${source.exists}`);
      if (!source.exists) {
        throw new AppError(
          "source_object_missing",
          "The source no longer exists at this job's exact Cloudflare R2 key.",
          { detail: `job=${id} stage=retry sourceObjectKey=${job.sourceObjectKey}`, status: 410 },
        );
      }
    }
    console.info(`[retry checkpoint] job=${id} stage=${job.stage} transcript=${Boolean(job.transcript)} analysisSelection=${Boolean(job.analysisCheckpoint?.selectionComplete)} sourceObjectKey=${job.sourceObjectKey ?? "none"}`);

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
      { error: payload.message, kind: payload.kind, detail: payload.detail },
      { status: error instanceof AppError ? error.status : 500 },
    );
  }
}
