import fsp from "node:fs/promises";
import path from "node:path";
import { asc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { jobMediaAssets, mediaAssets } from "@/db/schema";
import { AppError } from "./errors";
import type { MusicEnergyAnalysis } from "./ffmpeg";
import { downloadObjectToFile } from "./object-storage";
import type { ClipCandidate } from "./types";

export const MEDIA_CATEGORIES = ["music", "sound_effect"] as const;
export type MediaCategory = (typeof MEDIA_CATEGORIES)[number];
export type MediaMode = "none" | "manual" | "auto";

export const MUSIC_TAGS = ["Motivational", "Cinematic", "Dramatic", "Powerful", "Nostalgic", "Mysterious", "Chaotic"];
export const SOUND_EFFECT_TAGS = ["Whoosh", "Impact", "Transition", "Notification", "Riser", "Hit", "Ambient"];

export type LibraryAsset = {
  id: string;
  category: MediaCategory;
  name: string;
  fileName: string;
  contentType: string;
  objectKey: string;
  fileSizeBytes: number;
  durationSec: number | null;
  tags: string[];
  analysis: MusicEnergyAnalysis | null;
  createdAt: Date;
};

export function normalizeCategory(value: unknown): MediaCategory {
  if (value === "music" || value === "sound_effect") return value;
  throw new AppError("bad_request", "Media category must be music or sound_effect.", { status: 400 });
}

export function normalizeMediaMode(value: unknown): MediaMode {
  return value === "manual" || value === "auto" ? value : "none";
}

export function normalizeAssetIds(value: unknown): string[] {
  const values = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  return [...new Set(values.map((item) => String(item).trim()).filter((item) => /^asset_[a-z0-9_]+$/i.test(item)))].slice(0, 50);
}

export function normalizeTags(value: unknown): string[] {
  const values = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  return [...new Set(values.map((item) => String(item).trim().replace(/\s+/g, " ")).filter(Boolean).map((item) => item.slice(0, 40)))].slice(0, 12);
}

export function mediaApiAsset(row: typeof mediaAssets.$inferSelect) {
  return {
    id: row.id,
    category: row.category as MediaCategory,
    name: row.name,
    fileName: row.fileName,
    contentType: row.contentType,
    fileSizeBytes: row.fileSizeBytes,
    durationSec: row.durationSec,
    tags: row.tags ?? [],
    analysis: row.analysis ?? null,
    createdAt: row.createdAt.toISOString(),
    playbackUrl: `/api/media/${row.id}/file`,
  };
}

export async function resolveJobAssets(options: {
  musicIds: string[];
  soundEffectIds: string[];
  mediaMode: MediaMode;
}): Promise<Array<{ asset: typeof mediaAssets.$inferSelect; role: "music" | "sound_effect"; sortOrder: number }>> {
  let musicIds = options.mediaMode === "none" ? [] : options.musicIds;
  if (options.mediaMode === "auto" && !musicIds.length) {
    const allMusic = await db.select({ id: mediaAssets.id }).from(mediaAssets).where(eq(mediaAssets.category, "music")).orderBy(asc(mediaAssets.createdAt));
    musicIds = allMusic.map((item) => item.id);
  }
  const requested = [...new Set([...musicIds, ...options.soundEffectIds])];
  if (!requested.length) return [];
  const rows = await db.select().from(mediaAssets).where(inArray(mediaAssets.id, requested));
  if (rows.length !== requested.length) {
    throw new AppError("not_found", "One or more selected library assets no longer exist.", { status: 404 });
  }
  const byId = new Map(rows.map((row) => [row.id, row]));
  const result: Array<{ asset: typeof mediaAssets.$inferSelect; role: "music" | "sound_effect"; sortOrder: number }> = [];
  musicIds.forEach((id, index) => {
    const asset = byId.get(id);
    if (!asset || asset.category !== "music") throw new AppError("bad_request", "A selected music ID is not a music asset.", { status: 400 });
    result.push({ asset, role: "music", sortOrder: index });
  });
  options.soundEffectIds.forEach((id, index) => {
    const asset = byId.get(id);
    if (!asset || asset.category !== "sound_effect") throw new AppError("bad_request", "A selected sound-effect ID is not a sound effect.", { status: 400 });
    result.push({ asset, role: "sound_effect", sortOrder: index });
  });
  return result;
}

export async function getJobLibraryAssets(jobId: string): Promise<LibraryAsset[]> {
  const rows = await db
    .select({ asset: mediaAssets })
    .from(jobMediaAssets)
    .innerJoin(mediaAssets, eq(jobMediaAssets.assetId, mediaAssets.id))
    .where(eq(jobMediaAssets.jobId, jobId))
    .orderBy(asc(jobMediaAssets.sortOrder));
  return rows.map(({ asset }) => ({
    ...asset,
    category: asset.category as MediaCategory,
    tags: asset.tags ?? [],
    analysis: asset.analysis ?? null,
  }));
}

/** Metadata-only matching: uploaded music is never re-analyzed for a job. */
export function chooseMusicForClip(assets: LibraryAsset[], clip: ClipCandidate, clipIndex: number, mode: MediaMode): LibraryAsset | null {
  const music = assets.filter((asset) => asset.category === "music");
  if (!music.length || mode === "none") return null;
  if (mode === "manual") return music[clipIndex % music.length];
  const text = `${clip.title} ${clip.hook} ${clip.reason}`.toLowerCase();
  const cues: Record<string, string[]> = {
    motivational: ["inspire", "success", "growth", "win", "lesson", "hope"],
    cinematic: ["story", "journey", "reveal", "epic"],
    dramatic: ["conflict", "risk", "shock", "turn", "warning"],
    powerful: ["power", "strong", "decide", "change", "truth"],
    nostalgic: ["remember", "past", "child", "used to", "memory"],
    mysterious: ["secret", "unknown", "mystery", "why", "hidden"],
    chaotic: ["crazy", "chaos", "wild", "fast", "disaster"],
  };
  return music
    .map((asset, index) => {
      let score = (asset.analysis?.vibe === "energetic" || asset.analysis?.vibe === "intense") && (clip.score ?? 0) >= 75 ? 2 : 0;
      for (const tag of asset.tags) {
        const normalized = tag.toLowerCase();
        if (text.includes(normalized)) score += 4;
        score += (cues[normalized] ?? []).filter((cue) => text.includes(cue)).length * 2;
      }
      return { asset, score, stable: (index + clipIndex) % music.length };
    })
    .sort((a, b) => b.score - a.score || a.stable - b.stable)[0]?.asset ?? music[clipIndex % music.length];
}

export function chooseSoundEffectForClip(assets: LibraryAsset[], clipIndex: number): LibraryAsset | null {
  const effects = assets.filter((asset) => asset.category === "sound_effect");
  return effects.length ? effects[clipIndex % effects.length] : null;
}

export async function downloadLibraryAssets(assets: LibraryAsset[], workDir: string): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const directory = path.join(workDir, "library-assets");
  await fsp.mkdir(directory, { recursive: true });
  for (const asset of assets) {
    const extension = path.extname(asset.fileName).toLowerCase() || ".audio";
    const localPath = path.join(directory, `${asset.id}${extension}`);
    await downloadObjectToFile(asset.objectKey, localPath, { kind: "media", label: `Media Library asset ${asset.id}` });
    result.set(asset.id, localPath);
  }
  return result;
}
