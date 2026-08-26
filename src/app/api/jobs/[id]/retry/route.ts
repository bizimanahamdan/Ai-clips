import fsp from "node:fs/promises";
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { clips, jobEvents, jobs } from "@/db/schema";
import { AppError, toErrorPayload } from "@/lib/errors";
import { createJobDir } from "@/lib/storage";
import { ensureRuntime } from "@/lib/jobs";
import { config } from "@/lib/config";

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
    if (job.sourceType === "upload" && job.filePath) {
      const stat = await fsp.stat(job.filePath).catch(() => null);
      if (!stat) {
        throw new AppError(
          "unsupported_media",
          "The original upload is no longer on the server. Uploads are temporary after the retention window.",
          { status: 410 },
        );
      }
    }

    await createJobDir(id);
    await db.delete(clips).where(eq(clips.jobId, id));
    await db
      .update(jobs)
      .set({
        status: "queued",
        stage: "queued",
        stageDetail: "Queued for retry",
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
      message: "Retry requested — the pipeline will run again from the start.",
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
