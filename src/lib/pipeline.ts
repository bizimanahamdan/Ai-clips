import fsp from "node:fs/promises";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { clips, jobEvents, jobs } from "@/db/schema";
import { config, providersConfigured } from "./config";
import { AppError, toErrorPayload } from "./errors";
import { validateSource } from "./ingest";
import { analyseTranscript } from "./analyze";
import { extractPoster, mediaDurationSeconds, probeVideo, renderVerticalClip } from "./ffmpeg";
import { buildAssSubtitles, buildCaptionGroups, subtitleOptionsFor } from "./subtitles";
import { clipFileName, createJobDir, removePath } from "./storage";
import { clipObjectKey, uploadFileToR2 } from "./object-storage";
import { acquireVideoSource } from "./video-source";
import { acquireAndAnalyzeMusic, musicOffsetForClip } from "./music";
import {
  chooseMusicForClip,
  chooseSoundEffectForClip,
  downloadLibraryAssets,
  getJobLibraryAssets,
  normalizeMediaMode,
} from "./media-library";
import { normalizeOutputFormat, outputDimensions } from "./output-format";
import { extractAndTranscribe } from "./transcribe";
import { validateClips } from "./validate";
import type { Stage, Transcript } from "./types";
import { STAGE_WEIGHTS } from "./types";

type Ctx = {
  jobId: string;
  workDir: string;
};

async function log(ctx: Ctx, level: "info" | "warn" | "error", stage: string, message: string) {
  await db.insert(jobEvents).values({ jobId: ctx.jobId, level, stage, message: message.slice(0, 2000) });
  if (level === "error") console.error(`[job ${ctx.jobId}] ${stage}: ${message}`);
  else if (level === "warn") console.warn(`[job ${ctx.jobId}] ${stage}: ${message}`);
  else console.log(`[job ${ctx.jobId}] ${stage}: ${message}`);
}

async function setStage(ctx: Ctx, stage: Stage, detail?: string, progressOverride?: number) {
  const progress =
    progressOverride ??
    (stage in STAGE_WEIGHTS ? STAGE_WEIGHTS[stage as keyof typeof STAGE_WEIGHTS] : undefined);
  await db
    .update(jobs)
    .set({
      stage,
      stageDetail: detail?.slice(0, 500) ?? null,
      progress: progress !== undefined ? Math.max(0, Math.min(99, Math.round(progress))) : undefined,
      updatedAt: new Date(),
    })
    .where(eq(jobs.id, ctx.jobId));
}

async function patchJob(ctx: Ctx, patch: Partial<typeof jobs.$inferInsert>) {
  await db
    .update(jobs)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(jobs.id, ctx.jobId));
}

/**
 * The whole pipeline. Every failure path throws AppError with a message a human
 * can act on, and the job row keeps the stage + detail for debugging.
 */
export async function runPipeline(jobId: string): Promise<void> {
  const ctx: Ctx = { jobId, workDir: "" };
  const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
  if (!job) throw new AppError("not_found", `Job ${jobId} disappeared from the database.`);
  const libraryAssets = await getJobLibraryAssets(jobId);
  const mediaMode = normalizeMediaMode(job.mediaMode);

  try {
    await patchJob(ctx, {
      status: "processing",
      stage: "acquiring",
      startedAt: new Date(),
      error: null,
    });

    ctx.workDir = await createJobDir(jobId);
    await patchJob(ctx, { workDir: ctx.workDir });

    /* Optional music is validated before acquiring/processing the video. */
    let backgroundMusic: Awaited<ReturnType<typeof acquireAndAnalyzeMusic>> | null = null;
    if (job.musicObjectKey && job.musicFileName) {
      await setStage(ctx, "analyzing_music", "Validating and analyzing background music…", 2);
      backgroundMusic = await acquireAndAnalyzeMusic({
        objectKey: job.musicObjectKey,
        fileName: job.musicFileName,
        workDir: ctx.workDir,
      });
      await patchJob(ctx, { musicAnalysis: backgroundMusic.analysis });
      await log(
        ctx,
        "info",
        "analyzing_music",
        `Music ready: ${backgroundMusic.analysis.durationSec.toFixed(1)}s, ${backgroundMusic.analysis.vibe}${backgroundMusic.analysis.estimatedBpm ? `, ~${backgroundMusic.analysis.estimatedBpm} BPM` : ""}`,
      );
    }

    /* 1. Acquire a normalized local source ----------------------------- */
    const isRemote = job.sourceType !== "upload";
    await setStage(
      ctx,
      "acquiring",
      isRemote ? `Starting ${job.sourceType.replace("_", " ")} video download…` : "Restoring uploaded video from Cloudflare R2…",
      4,
    );
    let lastAcquisitionUpdate = 0;
    const acquired = await acquireVideoSource(job, ctx.workDir, (bytes, total) => {
      const now = Date.now();
      if (now - lastAcquisitionUpdate < 1000 && (!total || bytes < total)) return;
      lastAcquisitionUpdate = now;
      const ratio = total ? Math.min(1, bytes / total) : 0;
      void setStage(
        ctx,
        "acquiring",
        `Downloading source… ${(bytes / 1024 / 1024).toFixed(1)}MB${total ? ` / ${(total / 1024 / 1024).toFixed(1)}MB` : ""}`,
        Math.round(4 + ratio * 6),
      ).catch(() => undefined);
    });
    const sourcePath = acquired.localPath;
    await patchJob(ctx, {
      filePath: sourcePath,
      sourceObjectKey: acquired.durableObjectKey,
      fileSizeBytes: acquired.sizeBytes,
      sourceName: acquired.fileName,
    });
    await log(
      ctx,
      "info",
      "acquiring",
      `${acquired.provider} source acquired (${(acquired.sizeBytes / 1024 / 1024).toFixed(1)}MB)${acquired.durableObjectKey ? " and retained in R2" : " as temporary scratch only"}`,
    );

    /* 2. Probe ----------------------------------------------------------- */
    await setStage(ctx, "probing", "Reading video metadata…");
    const probe = await validateSource(sourcePath, job.sourceName);
    await patchJob(ctx, {
      durationSec: probe.durationSec,
      width: probe.width,
      height: probe.height,
      hasAudio: probe.hasAudio ? 1 : 0,
      fileSizeBytes: probe.sizeBytes,
    });
    await log(
      ctx,
      "info",
      "probing",
      `${probe.width ?? "?"}x${probe.height ?? "?"} ${probe.videoCodec ?? "?"}/${probe.audioCodec ?? "?"}, ${probe.durationSec.toFixed(1)}s`,
    );

    /* 3 + 4. Audio + transcription -------------------------------------- */
    await setStage(ctx, "extracting_audio", "Extracting 16kHz mono audio…");
    const { transcript, audioPath } = await extractAndTranscribe({
      videoPath: sourcePath,
      workDir: ctx.workDir,
      durationSec: probe.durationSec,
      language: job.language,
      onProgress: (ratio, message) => {
        const base = STAGE_WEIGHTS.extracting_audio;
        const span = STAGE_WEIGHTS.transcribing - base;
        void setStage(
          ctx,
          ratio < 0.02 ? "extracting_audio" : "transcribing",
          message,
          Math.round(base + Math.min(1, ratio) * span),
        ).catch(() => undefined);
      },
    });
    await patchJob(ctx, {
      transcript,
      transcriptText: transcript.text.slice(0, 200_000),
      language: transcript.language,
    });
    await log(
      ctx,
      "info",
      "transcribing",
      `${transcript.words.length} words, ${transcript.segments.length} segments, ${transcript.chunkCount} chunk(s), lang=${transcript.language ?? "?"}`,
    );

    /* 5. AI moment selection -------------------------------------------- */
    const providers = providersConfigured();
    if (!providers.order.length) {
      throw new AppError(
        "missing_api_key",
        "No AI provider is configured for clip analysis.",
        { detail: "Set GEMINI_API_KEY for direct Gemini analysis and/or configure OpenRouter or Groq fallback." },
      );
    }
    await setStage(ctx, "preparing_transcript", "Preparing timestamped transcript parts…", 55);
    const preferredVibes = mediaMode === "auto"
      ? [...new Set(libraryAssets.filter((asset) => asset.category === "music").flatMap((asset) => asset.tags))]
      : [];
    const analysis = await analyseTranscript({
      transcript,
      durationSec: probe.durationSec,
      clipCount: job.requestedClips,
      maxClipSec: job.maxClipSec,
      preferredVibes,
      onProgress: async (progress) => {
        if (progress.phase === "preparing") {
          await setStage(ctx, "preparing_transcript", progress.message, 55);
        } else if (progress.phase === "discovery") {
          const ratio = progress.total ? progress.completed / progress.total : 0;
          await setStage(ctx, "analyzing", progress.message, Math.round(57 + ratio * 9));
        } else {
          await setStage(ctx, "ranking", progress.message, 67);
        }
      },
    });
    await patchJob(ctx, {
      analysisProvider: analysis.provider,
      analysisModel: analysis.model,
    });
    for (const attempt of analysis.attempts) {
      if (attempt.outcome === "failed") {
        await log(ctx, "warn", "analyzing", `${attempt.provider}/${attempt.model} attempt ${attempt.attempt} failed: ${attempt.detail}`);
      }
    }
    await log(
      ctx,
      "info",
      "analyzing",
      `${analysis.provider}/${analysis.model} completed ${analysis.chunkCount} transcript part(s), discovered ${analysis.discoveredCandidates} candidate(s), and selected ${analysis.clips.length} final clip(s)`,
    );

    /* 6. Validate -------------------------------------------------------- */
    await setStage(ctx, "selecting", "Validating timestamps…");
    const rejected: string[] = [];
    const validated = validateClips({
      candidates: analysis.clips,
      durationSec: probe.durationSec,
      transcript,
      requestedClips: job.requestedClips,
      maxClipSec: job.maxClipSec,
      rejected,
    });
    for (const issue of rejected) await log(ctx, "warn", "selecting", issue);

    await db.delete(clips).where(eq(clips.jobId, jobId));
    const clipRows = validated.map((clip) => ({
      id: `${jobId}-c${clip.index + 1}`,
      jobId,
      clipIndex: clip.index,
      status: "pending" as const,
      title: clip.title,
      hook: clip.hook,
      reason: clip.reason,
      score: clip.score,
      startSec: clip.startSec,
      endSec: clip.endSec,
      durationSec: Number((clip.endSec - clip.startSec).toFixed(2)),
    }));
    await db.insert(clips).values(clipRows);
    await log(
      ctx,
      "info",
      "selecting",
      validated.map((c) => `#${c.index + 1} ${c.startSec.toFixed(1)}-${c.endSec.toFixed(1)}s (${c.score}/100) ${c.title}`).join(" | "),
    );

    const mediaSelections = validated.map((clip, index) => ({
      music: chooseMusicForClip(libraryAssets, clip, index, mediaMode),
      soundEffect: chooseSoundEffectForClip(libraryAssets, index),
    }));
    const requiredLibraryAssets = [...new Map(
      mediaSelections.flatMap((item) => [item.music, item.soundEffect]).filter((item) => item !== null).map((item) => [item.id, item]),
    ).values()];
    const localLibraryFiles = requiredLibraryAssets.length
      ? await downloadLibraryAssets(requiredLibraryAssets, ctx.workDir)
      : new Map<string, string>();
    if (requiredLibraryAssets.length) {
      await log(ctx, "info", "selecting", `Using ${requiredLibraryAssets.length} reusable media library asset(s); stored metadata was reused without library-wide analysis.`);
    }

    /* 7. Render ---------------------------------------------------------- */
    const outputFormat = normalizeOutputFormat(job.outputFormat);
    const dimensions = outputDimensions(outputFormat);
    const renderEnhancements = [job.subtitlesEnabled !== 0 ? "captions" : "", requiredLibraryAssets.length || backgroundMusic ? "music/effects" : ""].filter(Boolean).join(" and ");
    await setStage(ctx, "rendering", `Rendering ${validated.length} ${outputFormat} clip(s)${renderEnhancements ? ` with ${renderEnhancements}` : ""}…`);
    const subtitleOpts = subtitleOptionsFor(dimensions.width, dimensions.height);
    let readyCount = 0;
    let failedCount = 0;

    for (let index = 0; index < validated.length; index += 1) {
      const clip = validated[index];
      const mediaSelection = mediaSelections[index];
      const clipId = `${jobId}-c${index + 1}`;
      const base = STAGE_WEIGHTS.rendering + (index / validated.length) * (STAGE_WEIGHTS.finalizing - STAGE_WEIGHTS.rendering - 1);
      const span = (STAGE_WEIGHTS.finalizing - STAGE_WEIGHTS.rendering - 1) / validated.length;

      await db.update(clips).set({ status: "rendering", error: null }).where(eq(clips.id, clipId));
      await setStage(
        ctx,
        "rendering",
        `Rendering clip ${index + 1}/${validated.length}: ${clip.title}`,
        Math.round(base),
      );

      const outputPath = path.join(ctx.workDir, `clip-${index + 1}.mp4`);
      let subtitlePath: string | undefined;
      try {
        if (job.subtitlesEnabled !== 0) {
          if (clip.words.length >= 2) {
            const groups = buildCaptionGroups(clip.words);
            if (groups.length) {
              subtitlePath = path.join(ctx.workDir, `clip-${index + 1}.ass`);
              await fsp.writeFile(subtitlePath, buildAssSubtitles(groups, subtitleOpts), "utf8");
            }
          } else {
            await log(ctx, "warn", "rendering", `Clip ${index + 1} has no usable word timestamps — rendering without captions.`);
          }
        }

        const renderOptions = {
          input: sourcePath,
          output: outputPath,
          startSec: clip.startSec,
          endSec: clip.endSec,
          subtitlePath,
          subtitlesEnabled: Boolean(subtitlePath),
          targetWidth: dimensions.width,
          targetHeight: dimensions.height,
          targetFps: config.targetFps,
          crf: config.videoCrf,
          preset: config.videoPreset,
          audioBitrateK: config.audioBitrateK,
          hasAudio: probe.hasAudio,
          framingMode: outputFormat === "16:9" ? "fit" as const : "crop" as const,
          onProgress: (ratio: number) => {
            void setStage(
              ctx,
              "rendering",
              `Rendering clip ${index + 1}/${validated.length}: ${Math.round(ratio * 100)}%`,
              Math.round(base + Math.min(1, ratio) * span),
            ).catch(() => undefined);
          },
        };
        const libraryMusic = mediaSelection.music;
        const savedMusicAnalysis = libraryMusic?.analysis ?? null;
        const selectedMusic = libraryMusic
          ? {
              input: localLibraryFiles.get(libraryMusic.id) as string,
              startOffsetSec: savedMusicAnalysis ? musicOffsetForClip(savedMusicAnalysis, index) : 0,
              volume: savedMusicAnalysis?.vibe === "intense" ? 0.13 : 0.18,
            }
          : backgroundMusic
            ? {
                input: backgroundMusic.localPath,
                startOffsetSec: musicOffsetForClip(backgroundMusic.analysis, index),
                volume: backgroundMusic.analysis.vibe === "intense" ? 0.13 : 0.18,
              }
            : undefined;
        const selectedEffect = mediaSelection.soundEffect
          ? { input: localLibraryFiles.get(mediaSelection.soundEffect.id) as string, atSec: 0.12, volume: 0.32 }
          : undefined;
        try {
          await renderVerticalClip({
            ...renderOptions,
            music: selectedMusic,
            soundEffects: selectedEffect ? [selectedEffect] : undefined,
          });
        } catch (error) {
          if (!selectedMusic && !selectedEffect) throw error;
          await log(ctx, "warn", "rendering", `Library audio mix failed for clip ${index + 1}; retrying safely without added audio. ${(error as Error).message}`);
          await fsp.rm(outputPath, { force: true });
          await renderVerticalClip(renderOptions);
        }

        const outStat = await fsp.stat(outputPath).catch(() => null);
        if (!outStat || outStat.size < 10_000) {
          throw new AppError("ffmpeg_error", "Rendered clip is missing or suspiciously small.");
        }
        const outProbe = await probeVideo(outputPath);
        const fileName = clipFileName(index, clip.title);
        const objectKey = clipObjectKey(jobId, fileName);
        const posterPath = path.join(ctx.workDir, `clip-${index + 1}.jpg`);
        const posterKey = objectKey.replace(/\.mp4$/, ".jpg");

        await setStage(ctx, "rendering", `Uploading clip ${index + 1}/${validated.length} to Cloudflare R2…`);
        await uploadFileToR2(outputPath, objectKey, "video/mp4");
        const hasPoster = await extractPoster({
          input: outputPath,
          output: posterPath,
          atSec: Math.min(2, Math.max(0.1, outProbe.durationSec / 2)),
          width: 270,
        });
        let posterStored = false;
        if (hasPoster) {
          try {
            await uploadFileToR2(posterPath, posterKey, "image/jpeg");
            posterStored = true;
          } catch (error) {
            await log(ctx, "warn", "rendering", `Clip ${index + 1} poster upload failed: ${(error as Error).message}`);
          }
        }

        await db
          .update(clips)
          .set({
            status: "ready",
            filePath: null,
            objectKey,
            posterObjectKey: posterStored ? posterKey : null,
            fileName,
            fileSizeBytes: outStat.size,
            width: outProbe.width,
            height: outProbe.height,
            durationSec: outProbe.durationSec,
          })
          .where(eq(clips.id, clipId));
        readyCount += 1;
        await log(ctx, "info", "rendering", `Clip ${index + 1} ready (${(outStat.size / (1024 * 1024)).toFixed(1)}MB, ${outProbe.width}x${outProbe.height})`);
      } catch (error) {
        failedCount += 1;
        const payload = toErrorPayload(error);
        await db.update(clips).set({ status: "failed", error: payload.message }).where(eq(clips.id, clipId));
        await log(ctx, "error", "rendering", `Clip ${index + 1} failed: ${payload.message}${payload.detail ? ` — ${payload.detail.slice(0, 400)}` : ""}`);
        await fsp.rm(outputPath, { force: true });
      } finally {
        if (subtitlePath) await fsp.rm(subtitlePath, { force: true });
        await fsp.rm(outputPath, { force: true });
        await fsp.rm(path.join(ctx.workDir, `clip-${index + 1}.jpg`), { force: true });
      }
    }

    /* 8. Finalize -------------------------------------------------------- */
    await setStage(ctx, "finalizing", "Cleaning intermediate files…", 99);
    await fsp.rm(audioPath, { force: true });

    const ready = await db
      .select()
      .from(clips)
      .where(and(eq(clips.jobId, jobId), eq(clips.status, "ready")));

    const status = readyCount === 0 ? "failed" : failedCount > 0 ? "partial" : "completed";
    if (status === "failed") {
      throw new AppError("ffmpeg_error", "Every clip failed to render. See the clip errors below for the FFmpeg output.");
    }

    await patchJob(ctx, {
      status,
      stage: "done",
      stageDetail: `${readyCount} clip(s) ready${failedCount ? `, ${failedCount} failed` : ""}`,
      progress: 100,
      finishedAt: new Date(),
      expiresAt: new Date(Date.now() + config.retentionHours * 3600 * 1000),
    });
    await log(ctx, "info", "done", `Job finished: ${readyCount} ready, ${failedCount} failed.`);
  } catch (error) {
    const payload = toErrorPayload(error);
    const status = payload.kind === "interrupted" ? "failed" : "failed";
    await patchJob(ctx, {
      status,
      stage: "failed",
      stageDetail: payload.message,
      error: { message: payload.message, stage: "pipeline", detail: payload.detail, kind: payload.kind },
      finishedAt: new Date(),
    });
    await log(ctx, "error", "failed", `${payload.message}${payload.detail ? ` — ${payload.detail.slice(0, 800)}` : ""}`);
    throw error;
  } finally {
    // Local disk is scratch space only. Durable sources and outputs are in R2.
    const [latest] = await db.select({ filePath: jobs.filePath }).from(jobs).where(eq(jobs.id, jobId)).limit(1).catch(() => []);
    if (latest?.filePath) await fsp.rm(latest.filePath, { force: true }).catch(() => undefined);
    if (ctx.workDir) await removePath(ctx.workDir).catch(() => undefined);
    await db.update(jobs).set({ filePath: null, workDir: null, updatedAt: new Date() }).where(eq(jobs.id, jobId)).catch(() => undefined);
  }
}

/** Used by tests / manual verification without touching the network. */
export async function probeSource(filePath: string): Promise<{ durationSec: number }> {
  return { durationSec: await mediaDurationSeconds(filePath) };
}
