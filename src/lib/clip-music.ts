import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { and, eq, ne } from "drizzle-orm";
import { getDb } from "@/db";
import { clips, mediaAssets } from "@/db/schema";
import { AppError } from "./errors";
import { mixPostRenderMusic, probeVideo } from "./ffmpeg";
import { deleteObject, downloadObjectToFile, headObject, uploadFileToR2 } from "./object-storage";

const ROOT = "/tmp/clipforge";

async function readyClip(id: string) {
  const [clip] = await getDb().select().from(clips).where(eq(clips.id, id)).limit(1);
  if (!clip) throw new AppError("not_found", "Clip not found.", { status: 404 });
  if (clip.status !== "ready" || !clip.objectKey) throw new AppError("bad_request", "Only ready, persisted clips can receive music.", { status: 409 });
  if (clip.musicStatus === "applying" || clip.musicStatus === "uploading") throw new AppError("bad_request", "Music is already being applied to this clip.", { status: 409 });
  return clip;
}

export async function applyClipMusic(clipId: string, assetId: string, requestedVolume = 0.12) {
  const clip = await readyClip(clipId);
  const [asset] = await getDb().select().from(mediaAssets).where(and(eq(mediaAssets.id, assetId), eq(mediaAssets.category, "music"))).limit(1);
  if (!asset) throw new AppError("not_found", "Music asset not found in the Media Library.", { status: 404 });
  const originalKey = clip.originalObjectKey || clip.objectKey!;
  const volume = Math.max(0.01, Math.min(0.5, requestedVolume));
  const attempt = randomUUID();
  const workDir = path.join(ROOT, `clip-music-${clip.id}-${attempt}`);
  const clipPath = path.join(workDir, "clip.mp4");
  const musicPath = path.join(workDir, `music${path.extname(asset.fileName) || ".audio"}`);
  const outputPath = path.join(workDir, "mixed.mp4");
  const outputKey = `clips/${clip.jobId}/${clip.id}/music/${Date.now()}-${attempt}.mp4`;
  let uploaded = false;
  const claimed = await getDb().update(clips).set({ musicStatus: "applying", musicError: null })
    .where(and(eq(clips.id, clip.id), ne(clips.musicStatus, "applying"), ne(clips.musicStatus, "uploading")))
    .returning({ id: clips.id });
  if (!claimed.length) throw new AppError("bad_request", "Music is already being applied to this clip.", { status: 409 });
  try {
    const [clipHead, musicHead] = await Promise.all([headObject(originalKey), headObject(asset.objectKey)]);
    if (!clipHead.exists) throw new AppError("source_object_missing", "The exact retained no-music clip is missing from R2.", { detail: `clipId=${clip.id}; key=${originalKey}; stage=post_music_download`, status: 410 });
    if (!musicHead.exists) throw new AppError("source_object_missing", "The exact selected Media Library music object is missing from R2.", { detail: `clipId=${clip.id}; assetId=${asset.id}; key=${asset.objectKey}; stage=post_music_download`, status: 410 });
    await fsp.mkdir(workDir, { recursive: true });
    await Promise.all([
      downloadObjectToFile(originalKey, clipPath, { kind: "clip", label: `retained no-music clip ${clip.id}`, stage: "post_music_download" }),
      downloadObjectToFile(asset.objectKey, musicPath, { kind: "media", label: `Media Library music asset ${asset.id}`, stage: "post_music_download" }),
    ]);
    const [clipProbe, musicProbe] = await Promise.all([probeVideo(clipPath), probeVideo(musicPath)]);
    if (!clipProbe.hasVideo || clipProbe.durationSec <= 0) throw new AppError("unsupported_media", "The persisted clip is not a valid video.", { status: 422 });
    if (!musicProbe.hasAudio || musicProbe.durationSec <= 0) throw new AppError("unsupported_media", "The selected asset does not contain valid audio.", { status: 422 });
    await mixPostRenderMusic({ clipInput: clipPath, musicInput: musicPath, output: outputPath, durationSec: clipProbe.durationSec, clipHasAudio: clipProbe.hasAudio, volume });
    const outputProbe = await probeVideo(outputPath);
    if (!outputProbe.hasVideo || !outputProbe.hasAudio) throw new AppError("ffmpeg_error", "The mixed clip failed output validation.");
    await getDb().update(clips).set({ musicStatus: "uploading" }).where(eq(clips.id, clip.id));
    await uploadFileToR2(outputPath, outputKey, "video/mp4");
    uploaded = true;
    const outputHead = await headObject(outputKey);
    if (!outputHead.exists || !outputHead.sizeBytes) throw new AppError("internal", "The uploaded mixed clip could not be verified in R2.", { status: 502 });
    const switched = await getDb().update(clips).set({
      originalObjectKey: originalKey, objectKey: outputKey, musicAssetId: asset.id, musicObjectKey: asset.objectKey,
      musicVolume: volume, musicEnabled: 1, musicStatus: "complete", musicError: null,
      fileSizeBytes: outputHead.sizeBytes,
    }).where(and(eq(clips.id, clip.id), eq(clips.musicStatus, "uploading"))).returning({ id: clips.id });
    if (!switched.length) throw new AppError("internal", "The mixed clip uploaded, but its database reference could not be switched safely.");
    if (clip.musicEnabled && clip.objectKey !== originalKey && clip.objectKey !== outputKey) {
      await deleteObject(clip.objectKey!, "superseded-post-render-music").catch((error) => console.warn("Could not delete superseded mixed clip", error));
    }
    return { clipId: clip.id, status: "complete", objectKey: outputKey };
  } catch (error) {
    if (uploaded) await deleteObject(outputKey, "post-music-db-rollback").catch(() => undefined);
    await getDb().update(clips).set({ musicStatus: "failed", musicError: error instanceof Error ? error.message : String(error) }).where(eq(clips.id, clip.id));
    throw error;
  } finally {
    await fsp.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function removeClipMusic(clipId: string) {
  const clip = await readyClip(clipId);
  if (!clip.originalObjectKey || !clip.musicEnabled) return { clipId, status: "none" };
  const claimed = await getDb().update(clips).set({ musicStatus: "applying", musicError: null })
    .where(and(eq(clips.id, clip.id), ne(clips.musicStatus, "applying"), ne(clips.musicStatus, "uploading")))
    .returning({ id: clips.id });
  if (!claimed.length) throw new AppError("bad_request", "Music is already being changed on this clip.", { status: 409 });
  try {
    const originalHead = await headObject(clip.originalObjectKey);
    if (!originalHead.exists) throw new AppError("source_object_missing", "The retained no-music clip is missing from R2; the current working clip was not changed.", { detail: `clipId=${clip.id}; key=${clip.originalObjectKey}; stage=post_music_remove`, status: 410 });
    const oldMixedKey = clip.objectKey!;
    const restored = await getDb().update(clips).set({
      objectKey: clip.originalObjectKey, musicAssetId: null, musicObjectKey: null, musicEnabled: 0,
      musicStatus: "none", musicError: null, musicVolume: null, fileSizeBytes: originalHead.sizeBytes,
    }).where(and(eq(clips.id, clip.id), eq(clips.musicStatus, "applying"))).returning({ id: clips.id });
    if (!restored.length) throw new AppError("internal", "The retained original was verified, but its database reference could not be restored safely.");
    if (oldMixedKey !== clip.originalObjectKey) await deleteObject(oldMixedKey, "removed-post-render-music").catch((error) => console.warn("Could not delete removed mixed clip", error));
    return { clipId, status: "none" };
  } catch (error) {
    await getDb().update(clips).set({ musicStatus: "failed", musicError: error instanceof Error ? error.message : String(error) }).where(eq(clips.id, clip.id));
    throw error;
  }
}
