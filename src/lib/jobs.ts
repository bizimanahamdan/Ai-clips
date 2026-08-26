import { and, asc, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { clips, jobEvents, jobs } from "@/db/schema";
import { config } from "./config";
import { AppError } from "./errors";
import { checkBinaries } from "./ffmpeg";
import { runPipeline } from "./pipeline";
import {
  assertDiskSpace,
  assertStorageWritable,
  ensureStorage,
  jobRoot,
  pathExists,
  removePath,
} from "./storage";
import type { ApiJob, JobStatus, Stage } from "./types";
import { STAGE_LABELS } from "./types";

type QueueState = {
  pending: string[];
  running: Set<string>;
  booted: boolean;
  booting: Promise<void> | null;
  cleanupTimer: NodeJS.Timeout | null;
};

const globalForQueue = globalThis as typeof globalThis & {
  __clipforgeQueue?: QueueState;
};

function queue(): QueueState {
  if (!globalForQueue.__clipforgeQueue) {
    globalForQueue.__clipforgeQueue = {
      pending: [],
      running: new Set<string>(),
      booted: false,
      booting: null,
      cleanupTimer: null,
    };
  }
  return globalForQueue.__clipforgeQueue;
}

/**
 * Runs once per process: verify the environment (ffmpeg binaries, writable
 * storage), then recover jobs that were mid-flight when the server stopped.
 */
async function boot(): Promise<void> {
  await ensureStorage();
  await assertStorageWritable();
  await checkBinaries();

  const interrupted = await db
    .select({ id: jobs.id, filePath: jobs.filePath, status: jobs.status })
    .from(jobs)
    .where(inArray(jobs.status, ["queued", "processing"]))
    .orderBy(asc(jobs.createdAt));

  for (const job of interrupted) {
    if (job.status === "queued") {
      enqueue(job.id);
      continue;
    }
    // A job that was mid-flight: it can only resume if the source file survived.
    const sourceAlive = job.filePath ? await pathExists(job.filePath) : false;
    if (sourceAlive) {
      // Source file survived the restart: requeue honestly.
      await db
        .update(jobs)
        .set({
          status: "queued",
          stage: "queued",
          stageDetail: "Resuming after server restart",
          progress: 0,
          error: null,
        })
        .where(eq(jobs.id, job.id));
      await db.insert(jobEvents).values({
        jobId: job.id,
        level: "warn",
        stage: "recovery",
        message: "Server restarted during processing. Job was re-queued from the beginning.",
      });
      enqueue(job.id);
    } else {
      await db
        .update(jobs)
        .set({
          status: "failed",
          stage: "failed",
          stageDetail: "Interrupted by a server restart — temporary files were lost.",
          error: {
            kind: "interrupted",
            message: "Processing was interrupted by a server restart. Please run the job again.",
            stage: "processing",
          },
          finishedAt: new Date(),
        })
        .where(eq(jobs.id, job.id));
      await db.insert(jobEvents).values({
        jobId: job.id,
        level: "error",
        stage: "recovery",
        message: "Server restarted during processing and the temporary files were gone, so the job was marked failed.",
      });
    }
  }

  startCleanupScheduler();
}

export async function ensureRuntime(): Promise<void> {
  const state = queue();
  if (state.booted) return;
  if (state.booting) return state.booting;
  state.booting = boot()
    .then(() => {
      state.booted = true;
    })
    .finally(() => {
      state.booting = null;
    });
  return state.booting;
}

function enqueue(jobId: string): void {
  const state = queue();
  if (state.running.has(jobId) || state.pending.includes(jobId)) return;
  state.pending.push(jobId);
  pump();
}

/** Public hook so API routes can re-queue an existing job row. */
export function enqueueJob(jobId: string): void {
  enqueue(jobId);
}

function pump(): void {
  const state = queue();
  const limit = Math.max(1, config.maxConcurrentJobs);
  while (state.running.size < limit && state.pending.length) {
    const jobId = state.pending.shift();
    if (!jobId) break;
    state.running.add(jobId);
    void (async () => {
      try {
        await assertDiskSpace();
        await db
          .update(jobs)
          .set({ status: "processing", stage: "ingesting", updatedAt: new Date() })
          .where(and(eq(jobs.id, jobId), eq(jobs.status, "queued")));
        await runPipeline(jobId);
      } catch (error) {
        // runPipeline already persisted the failure; keep the log line for ops.
        console.error(`[queue] job ${jobId} failed:`, (error as Error).message);
      } finally {
        state.running.delete(jobId);
        pump();
      }
    })();
  }
}

export function queueSnapshot(): { pending: number; running: number } {
  const state = queue();
  return { pending: state.pending.length, running: state.running.size };
}

/* ------------------------------------------------------------------ */
/* Cleanup                                                             */
/* ------------------------------------------------------------------ */

export async function runCleanup(): Promise<{ removedJobs: number; removedDirs: string[] }> {
  const cutoff = new Date(Date.now() - config.retentionHours * 3600 * 1000);

  const expired = await db
    .select({ id: jobs.id, expiresAt: jobs.expiresAt })
    .from(jobs)
    .where(lt(jobs.createdAt, cutoff));

  const removable = expired.filter((job) => {
    if (job.expiresAt && job.expiresAt.getTime() > Date.now()) return false;
    return true;
  });

  const ids = removable.map((job) => job.id);
  if (ids.length) {
    await db.delete(jobs).where(inArray(jobs.id, ids));
  }

  const { purgeExpiredJobs } = await import("./storage");
  const removedDirs = await purgeExpiredJobs((expiresAt) => Boolean(expiresAt && expiresAt.getTime() <= Date.now()));

  return { removedJobs: ids.length, removedDirs };
}

export function startCleanupScheduler(): void {
  const state = queue();
  if (state.cleanupTimer) return;
  const minutes = Math.max(5, config.cleanupIntervalMinutes);
  state.cleanupTimer = setInterval(() => {
    void runCleanup().catch((error) => {
      console.error("[cleanup] failed:", (error as Error).message);
    });
  }, minutes * 60 * 1000);
  // Do not keep the process alive just for cleanup.
  state.cleanupTimer.unref?.();
}

/* ------------------------------------------------------------------ */
/* Job CRUD used by the API routes                                     */
/* ------------------------------------------------------------------ */

export type CreateJobInput = {
  sourceType: "upload" | "url";
  sourceName: string;
  sourceUrl?: string | null;
  filePath?: string | null;
  fileSizeBytes?: number | null;
  requestedClips?: number;
  maxClipSec?: number;
  subtitlesEnabled?: boolean;
  language?: string | null;
};

export async function createJob(input: CreateJobInput): Promise<string> {
  await ensureRuntime();
  await assertDiskSpace();

  const requestedClips = Math.min(
    config.maxClipCount,
    Math.max(1, Math.round(input.requestedClips ?? config.defaultClipCount)),
  );
  const maxClipSec = Math.min(
    config.maxClipSec,
    Math.max(config.minClipSec, Math.round(input.maxClipSec ?? 45)),
  );

  const id = `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  await db.insert(jobs).values({
    id,
    status: "queued",
    stage: "queued",
    sourceType: input.sourceType,
    sourceName: input.sourceName.slice(0, 200),
    sourceUrl: input.sourceUrl ?? null,
    filePath: input.filePath ?? null,
    fileSizeBytes: input.fileSizeBytes ?? null,
    requestedClips,
    maxClipSec,
    subtitlesEnabled: input.subtitlesEnabled === false ? 0 : 1,
    language: input.language ?? null,
    workDir: jobRoot(id),
    expiresAt: new Date(Date.now() + config.retentionHours * 3600 * 1000),
  });
  await db.insert(jobEvents).values({
    jobId: id,
    stage: "queued",
    message:
      input.sourceType === "url"
        ? `Job queued for URL: ${input.sourceUrl}`
        : `Job queued for upload: ${input.sourceName} (${((input.fileSizeBytes ?? 0) / (1024 * 1024)).toFixed(1)}MB)`,
  });
  enqueue(id);
  return id;
}

function mapClip(row: typeof clips.$inferSelect) {
  return {
    id: row.id,
    clipIndex: row.clipIndex,
    status: row.status,
    title: row.title,
    hook: row.hook,
    reason: row.reason,
    score: row.score,
    startSec: row.startSec,
    endSec: row.endSec,
    durationSec: row.durationSec,
    fileSizeBytes: row.fileSizeBytes,
    width: row.width,
    height: row.height,
    error: row.error,
    playbackUrl: row.status === "ready" ? `/api/clips/${row.id}/file` : null,
    downloadUrl: row.status === "ready" ? `/api/clips/${row.id}/file?download=1` : null,
  };
}

export async function getJob(jobId: string): Promise<ApiJob | null> {
  const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
  if (!job) return null;

  const clipRows = await db
    .select()
    .from(clips)
    .where(eq(clips.jobId, jobId))
    .orderBy(asc(clips.clipIndex));

  const eventRows = await db
    .select()
    .from(jobEvents)
    .where(eq(jobEvents.jobId, jobId))
    .orderBy(desc(jobEvents.id))
    .limit(40);

  const transcript = job.transcript as { text?: string } | null;

  return {
    id: job.id,
    status: job.status as JobStatus,
    stage: job.stage as Stage,
    stageLabel: STAGE_LABELS[job.stage as Stage] ?? job.stage,
    stageDetail: job.stageDetail,
    progress: job.progress,
    sourceType: job.sourceType,
    sourceName: job.sourceName,
    durationSec: job.durationSec,
    width: job.width,
    height: job.height,
    fileSizeBytes: job.fileSizeBytes,
    language: job.language,
    requestedClips: job.requestedClips,
    maxClipSec: job.maxClipSec,
    subtitlesEnabled: job.subtitlesEnabled === 1,
    analysisProvider: job.analysisProvider,
    analysisModel: job.analysisModel,
    error: job.error ?? null,
    createdAt: job.createdAt.toISOString(),
    finishedAt: job.finishedAt?.toISOString() ?? null,
    expiresAt: job.expiresAt?.toISOString() ?? null,
    clips: clipRows.map(mapClip),
    events: eventRows
      .map((event) => ({
        id: event.id,
        level: event.level,
        stage: event.stage,
        message: event.message,
        createdAt: event.createdAt.toISOString(),
      }))
      .reverse(),
    transcriptPreview: transcript?.text ? transcript.text.slice(0, 1200) : job.transcriptText?.slice(0, 1200) ?? null,
  };
}

export async function listJobs(limit = 12): Promise<ApiJob[]> {
  const rows = await db.select().from(jobs).orderBy(desc(jobs.createdAt)).limit(limit);
  if (!rows.length) return [];
  const ids = rows.map((row) => row.id);
  const clipRows = await db
    .select()
    .from(clips)
    .where(inArray(clips.jobId, ids))
    .orderBy(asc(clips.clipIndex));

  return rows.map((job) => ({
    id: job.id,
    status: job.status as JobStatus,
    stage: job.stage as Stage,
    stageLabel: STAGE_LABELS[job.stage as Stage] ?? job.stage,
    stageDetail: job.stageDetail,
    progress: job.progress,
    sourceType: job.sourceType,
    sourceName: job.sourceName,
    durationSec: job.durationSec,
    width: job.width,
    height: job.height,
    fileSizeBytes: job.fileSizeBytes,
    language: job.language,
    requestedClips: job.requestedClips,
    maxClipSec: job.maxClipSec,
    subtitlesEnabled: job.subtitlesEnabled === 1,
    analysisProvider: job.analysisProvider,
    analysisModel: job.analysisModel,
    error: job.error ?? null,
    createdAt: job.createdAt.toISOString(),
    finishedAt: job.finishedAt?.toISOString() ?? null,
    expiresAt: job.expiresAt?.toISOString() ?? null,
    clips: clipRows.filter((clip) => clip.jobId === job.id).map(mapClip),
    events: [],
    transcriptPreview: null,
  }));
}

export async function deleteJob(jobId: string): Promise<void> {
  const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
  if (!job) throw new AppError("not_found", `Job ${jobId} not found.`, { status: 404 });
  await db.delete(jobs).where(eq(jobs.id, jobId));
  await removePath(jobRoot(jobId));
}

export async function getJobStats(): Promise<{
  total: number;
  active: number;
  clipsReady: number;
  storageMb: number;
}> {
  const [row] = await db
    .select({
      total: sql<number>`count(*)::int`,
      active: sql<number>`count(*) filter (where status in ('queued','processing'))::int`,
    })
    .from(jobs);
  const [clipRow] = await db
    .select({
      ready: sql<number>`count(*) filter (where status = 'ready')::int`,
      bytes: sql<number>`coalesce(sum(file_size_bytes), 0)::bigint`,
    })
    .from(clips);
  return {
    total: row?.total ?? 0,
    active: row?.active ?? 0,
    clipsReady: clipRow?.ready ?? 0,
    storageMb: Math.round(Number(clipRow?.bytes ?? 0) / (1024 * 1024)),
  };
}
