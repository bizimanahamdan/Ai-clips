import { and, asc, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { clips, jobEvents, jobMediaAssets, jobs } from "@/db/schema";
import { config } from "./config";
import { AppError, toErrorPayload } from "./errors";
import { checkBinaries } from "./ffmpeg";
import { runPipeline } from "./pipeline";
import {
  assertDiskSpace,
  assertStorageWritable,
  ensureStorage,
  jobRoot,
  removePath,
} from "./storage";
import { checkR2, deleteObjects, deletePendingMusicOlderThan, headObject, sourceObjectKey } from "./object-storage";
import { normalizeOutputFormat, type OutputFormat } from "./output-format";
import { normalizeAssetIds, normalizeMediaMode, resolveJobAssets, type MediaMode } from "./media-library";
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
  await checkR2();

  console.log(`[startup] PostgreSQL, FFmpeg, and R2 bucket ${config.r2BucketName} are ready; temp=${config.storageDir}`);
  const interrupted = await db
    .select({ id: jobs.id, sourceType: jobs.sourceType, sourceObjectKey: jobs.sourceObjectKey, fileSizeBytes: jobs.fileSizeBytes, stage: jobs.stage, status: jobs.status })
    .from(jobs)
    .where(inArray(jobs.status, ["queued", "processing", "cleanup_pending"]))
    .orderBy(asc(jobs.createdAt));

  let cleanupInterrupted = false;
  for (const job of interrupted) {
    if (job.status === "cleanup_pending") {
      // A restart may interrupt retention cleanup between its R2 and database
      // steps. Return it to completed so the idempotent cleanup pass can retry.
      await db.update(jobs).set({ status: "completed", updatedAt: new Date() }).where(eq(jobs.id, job.id));
      cleanupInterrupted = true;
      console.warn(`[startup recovery] job=${job.id} priorStage=cleanup_pending action=restore-completed-for-cleanup-retry`);
      continue;
    }
    const sourceMetadata = job.sourceObjectKey ? await headObject(job.sourceObjectKey) : null;
    console.info(`[startup recovery] job=${job.id} priorStage=${job.stage} sourceObjectKey=${job.sourceObjectKey ?? "none"} bucket=${config.r2BucketName} exists=${sourceMetadata?.exists ?? false}`);
    const durableSourceMissing = job.sourceType === "upload"
      ? !job.sourceObjectKey || sourceMetadata?.exists !== true
      : Boolean(job.sourceObjectKey && job.fileSizeBytes !== null && sourceMetadata?.exists !== true);
    if (durableSourceMissing) {
      await db
        .update(jobs)
        .set({
          status: "failed",
          stage: "failed",
          stageDetail: "Persisted source object is missing from Cloudflare R2.",
          error: {
            kind: "source_object_missing",
            message: "The persisted source object is missing from Cloudflare R2.",
            detail: `job=${job.id} stage=${job.stage} sourceObjectKey=${job.sourceObjectKey ?? "none"}`,
            stage: job.stage,
          },
          finishedAt: new Date(),
          expiresAt: null,
        })
        .where(eq(jobs.id, job.id));
      await db.insert(jobEvents).values({
        jobId: job.id,
        level: "error",
        stage: "recovery",
        message: `SOURCE_OBJECT_MISSING: sourceObjectKey=${job.sourceObjectKey ?? "none"}, priorStage=${job.stage}`,
      });
      continue;
    }
    if (job.status === "processing") {
      await db
        .update(jobs)
        .set({
          status: "queued",
          stage: "queued",
          stageDetail: `Resuming saved checkpoints after restart (previous stage: ${job.stage})`,
          progress: 0,
          error: null,
        })
        .where(eq(jobs.id, job.id));
      await db.insert(jobEvents).values({
        jobId: job.id,
        level: "warn",
        stage: "recovery",
        message: `Server restarted during ${job.stage}; resuming from persisted checkpoints with sourceObjectKey=${job.sourceObjectKey ?? "none"}.`,
      });
    }
    enqueue(job.id);
  }

  if (cleanupInterrupted) await runCleanup();
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
  if (state.pending.includes(jobId)) return;
  state.pending.push(jobId);
  // If the previous attempt is still unwinding, its finally block will remove
  // the running marker and pump this saved-checkpoint retry exactly once.
  if (!state.running.has(jobId)) pump();
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
          .set({ status: "processing", stage: "acquiring", updatedAt: new Date() })
          .where(and(eq(jobs.id, jobId), eq(jobs.status, "queued")));
        await runPipeline(jobId);
      } catch (error) {
        // runPipeline persists its own failures. Persist failures that happened
        // before it started as well (for example, exhausted scratch disk).
        const payload = toErrorPayload(error);
        const [current] = await db.select({ status: jobs.status }).from(jobs).where(eq(jobs.id, jobId)).limit(1).catch(() => []);
        if (current && (current.status === "queued" || current.status === "processing")) {
          await db.update(jobs).set({
            status: "failed",
            stage: "failed",
            stageDetail: payload.message,
            error: { kind: payload.kind, message: payload.message, detail: payload.detail, stage: "queue" },
            finishedAt: new Date(),
            expiresAt: null,
            updatedAt: new Date(),
          }).where(eq(jobs.id, jobId)).catch(() => undefined);
          await db.insert(jobEvents).values({
            jobId,
            level: "error",
            stage: "queue",
            message: payload.message,
          }).catch(() => undefined);
        }
        console.error(`[queue] job ${jobId} failed:`, payload.message);
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

export async function runCleanup(): Promise<{ removedJobs: number; removedDirs: string[]; removedPendingMusic: number }> {
  const cutoff = new Date(Date.now() - config.retentionHours * 3600 * 1000);

  const expired = await db
    .select({ id: jobs.id, status: jobs.status, expiresAt: jobs.expiresAt })
    .from(jobs)
    .where(lt(jobs.createdAt, cutoff));

  const removable = expired.filter((job) => {
    if (job.status !== "completed") return false;
    if (job.expiresAt && job.expiresAt.getTime() > Date.now()) return false;
    return true;
  });

  const removedIds: string[] = [];
  for (const removableJob of removable) {
    // Atomically claim only a still-completed job. This closes the race where
    // manual retry could make a job active after the cleanup query.
    const claimed = await db
      .update(jobs)
      .set({ status: "cleanup_pending", updatedAt: new Date() })
      .where(and(eq(jobs.id, removableJob.id), eq(jobs.status, "completed")))
      .returning({ id: jobs.id, sourceKey: jobs.sourceObjectKey, musicKey: jobs.musicObjectKey });
    if (!claimed.length) continue;
    const storedClips = await db
      .select({ key: clips.objectKey, posterKey: clips.posterObjectKey })
      .from(clips)
      .where(eq(clips.jobId, removableJob.id));
    const outputObjectKeys = [
      claimed[0].musicKey,
      ...storedClips.flatMap((item) => [item.key, item.posterKey]),
    ];
    try {
      // Delete the source last. If any output cleanup fails, the durable source
      // remains available and the database keeps every object reference.
      await deleteObjects(outputObjectKeys, "completed-job-retention-expired-output");
      await deleteObjects([claimed[0].sourceKey], "completed-job-retention-expired-source");
      await db.delete(jobs).where(and(eq(jobs.id, removableJob.id), eq(jobs.status, "cleanup_pending")));
      removedIds.push(removableJob.id);
    } catch (error) {
      await db.update(jobs).set({ status: "completed", updatedAt: new Date() }).where(eq(jobs.id, removableJob.id));
      console.error(`[R2 cleanup] job=${removableJob.id} action=kept-references reason=object-delete-failed error=${(error as Error).message}`);
    }
  }

  const { purgeExpiredJobs } = await import("./storage");
  const removedDirs = await purgeExpiredJobs((expiresAt) => Boolean(expiresAt && expiresAt.getTime() <= Date.now()));
  const referencedMusic = await db.select({ key: jobs.musicObjectKey }).from(jobs);
  const protectedMusicKeys = new Set(referencedMusic.flatMap((item) => item.key ? [item.key] : []));
  const removedPendingMusic = await deletePendingMusicOlderThan(cutoff, protectedMusicKeys);

  return { removedJobs: removedIds.length, removedDirs, removedPendingMusic };
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
  id?: string;
  sourceType: "upload" | "direct_url" | "dropbox" | "google_drive" | "url";
  sourceName: string;
  sourceUrl?: string | null;
  filePath?: string | null;
  sourceObjectKey?: string | null;
  fileSizeBytes?: number | null;
  requestedClips?: number;
  maxClipSec?: number;
  subtitlesEnabled?: boolean;
  language?: string | null;
  outputFormat?: OutputFormat;
  musicObjectKey?: string | null;
  musicFileName?: string | null;
  mediaMode?: MediaMode;
  musicAssetIds?: string[];
  soundEffectAssetIds?: string[];
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

  const mediaMode = normalizeMediaMode(input.mediaMode);
  const id = input.id ?? `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const remoteSource = input.sourceType !== "upload";
  const authoritativeSourceKey = input.sourceObjectKey
    ?? (remoteSource ? sourceObjectKey(id, input.sourceName) : null);
  let authoritativeSourceSize = input.fileSizeBytes ?? null;
  if (input.sourceType === "upload") {
    if (!authoritativeSourceKey) {
      throw new AppError("internal", "Uploaded video has no persisted R2 source key.");
    }
    const uploaded = await headObject(authoritativeSourceKey);
    console.info(
      `[R2 verify-upload] bucket=${config.r2BucketName} key=${authoritativeSourceKey} exists=${uploaded.exists} size=${uploaded.sizeBytes ?? "unknown"} contentType=${uploaded.contentType ?? "unknown"}`,
    );
    if (!uploaded.exists) {
      throw new AppError("download_failed", "Cloudflare R2 did not confirm the uploaded source video.", {
        detail: `job=${id} sourceObjectKey=${authoritativeSourceKey}`,
        status: 502,
      });
    }
    if (uploaded.sizeBytes !== null && input.fileSizeBytes !== null && input.fileSizeBytes !== undefined && uploaded.sizeBytes !== input.fileSizeBytes) {
      throw new AppError("internal", "Cloudflare R2 reported an unexpected source-video size after upload.", {
        detail: `job=${id} sourceObjectKey=${authoritativeSourceKey} streamed=${input.fileSizeBytes} stored=${uploaded.sizeBytes}`,
        status: 502,
      });
    }
    authoritativeSourceSize = uploaded.sizeBytes ?? authoritativeSourceSize;
  }
  const selectedAssets = await resolveJobAssets({
    mediaMode,
    musicIds: normalizeAssetIds(input.musicAssetIds),
    soundEffectIds: normalizeAssetIds(input.soundEffectAssetIds),
  });
  await db.transaction(async (tx) => {
    await tx.insert(jobs).values({
      id,
      status: "queued",
      stage: "queued",
      sourceType: input.sourceType,
      sourceName: input.sourceName.slice(0, 200),
      sourceUrl: input.sourceUrl ?? null,
      filePath: input.filePath ?? null,
      sourceObjectKey: authoritativeSourceKey,
      fileSizeBytes: authoritativeSourceSize,
      requestedClips,
      maxClipSec,
      subtitlesEnabled: input.subtitlesEnabled === false ? 0 : 1,
      language: input.language ?? null,
      outputFormat: normalizeOutputFormat(input.outputFormat),
      musicObjectKey: input.musicObjectKey ?? null,
      musicFileName: input.musicFileName?.slice(0, 200) ?? null,
      mediaMode,
      workDir: jobRoot(id),
      expiresAt: new Date(Date.now() + config.retentionHours * 3600 * 1000),
    });
    if (selectedAssets.length) {
      await tx.insert(jobMediaAssets).values(selectedAssets.map((item) => ({
        jobId: id,
        assetId: item.asset.id,
        role: item.role,
        sortOrder: item.sortOrder,
      })));
    }
    await tx.insert(jobEvents).values({
      jobId: id,
      stage: "queued",
      message:
        input.sourceType !== "upload"
          ? `${input.sourceType.replace("_", " ")} job queued: ${input.sourceUrl}`
          : `Job queued for upload: ${input.sourceName} (${((authoritativeSourceSize ?? 0) / (1024 * 1024)).toFixed(1)}MB), sourceObjectKey=${authoritativeSourceKey}`,
    });
  });
  console.info(`[job create] job=${id} sourceType=${input.sourceType} sourceObjectKey=${authoritativeSourceKey ?? "none"}`);
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
    musicAssetId: row.musicAssetId,
    musicVolume: row.musicVolume,
    musicEnabled: row.musicEnabled === 1,
    musicStatus: row.musicStatus,
    musicError: row.musicError,
    playbackUrl: row.status === "ready" ? `/api/clips/${row.id}/file?v=${encodeURIComponent(row.objectKey?.split("/").pop() ?? "none")}` : null,
    downloadUrl: row.status === "ready" ? `/api/clips/${row.id}/file?download=1&v=${encodeURIComponent(row.objectKey?.split("/").pop() ?? "none")}` : null,
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

  const mediaRows = await db
    .select({ assetId: jobMediaAssets.assetId, role: jobMediaAssets.role })
    .from(jobMediaAssets)
    .where(eq(jobMediaAssets.jobId, jobId));

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
    outputFormat: normalizeOutputFormat(job.outputFormat),
    musicFileName: job.musicFileName,
    mediaMode: normalizeMediaMode(job.mediaMode),
    musicAssetIds: mediaRows.filter((item) => item.role === "music").map((item) => item.assetId),
    soundEffectAssetIds: mediaRows.filter((item) => item.role === "sound_effect").map((item) => item.assetId),
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
  const mediaRows = await db
    .select({ jobId: jobMediaAssets.jobId, assetId: jobMediaAssets.assetId, role: jobMediaAssets.role })
    .from(jobMediaAssets)
    .where(inArray(jobMediaAssets.jobId, ids));

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
    outputFormat: normalizeOutputFormat(job.outputFormat),
    musicFileName: job.musicFileName,
    mediaMode: normalizeMediaMode(job.mediaMode),
    musicAssetIds: mediaRows.filter((item) => item.jobId === job.id && item.role === "music").map((item) => item.assetId),
    soundEffectAssetIds: mediaRows.filter((item) => item.jobId === job.id && item.role === "sound_effect").map((item) => item.assetId),
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
  if (job.status === "queued" || job.status === "processing" || job.status === "cleanup_pending") {
    throw new AppError("bad_request", "An active job cannot be deleted while it may still need its source video.", { status: 409 });
  }
  const storedClips = await db
    .select({ key: clips.objectKey, posterKey: clips.posterObjectKey })
    .from(clips)
    .where(eq(clips.jobId, jobId));
  const outputObjectKeys = [
    job.musicObjectKey,
    ...storedClips.flatMap((item) => [item.key, item.posterKey]),
  ];
  // Keep database references unless all idempotent deletes succeed, and delete
  // the source last so a failure removing outputs cannot destroy retry data.
  await deleteObjects(outputObjectKeys, "user-deleted-job-output");
  await deleteObjects([job.sourceObjectKey], "user-deleted-job-source");
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
