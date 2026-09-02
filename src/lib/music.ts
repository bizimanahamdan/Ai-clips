import path from "node:path";
import { config } from "./config";
import { AppError } from "./errors";
import { analyzeMusicEnergy, probeVideo, type MusicEnergyAnalysis } from "./ffmpeg";
import { downloadObjectToFile } from "./object-storage";

const MUSIC_EXTENSIONS = new Set([".mp3", ".wav", ".m4a", ".aac"]);

export function validateMusicReference(objectKey?: string | null, fileName?: string | null): {
  objectKey: string | null;
  fileName: string | null;
} {
  if (!objectKey && !fileName) return { objectKey: null, fileName: null };
  if (!objectKey?.startsWith("pending-music/") || !fileName) {
    throw new AppError("bad_request", "Invalid background music upload reference.", { status: 400 });
  }
  const extension = path.extname(fileName).toLowerCase();
  if (!MUSIC_EXTENSIONS.has(extension)) {
    throw new AppError("unsupported_media", "Background music must be MP3, WAV, M4A, or AAC.", { status: 415 });
  }
  return { objectKey, fileName: path.basename(fileName).slice(0, 200) };
}

export async function acquireAndAnalyzeMusic(options: {
  objectKey: string;
  fileName: string;
  workDir: string;
}): Promise<{ localPath: string; analysis: MusicEnergyAnalysis }> {
  const extension = path.extname(options.fileName).toLowerCase();
  if (!MUSIC_EXTENSIONS.has(extension)) {
    throw new AppError("unsupported_media", "Background music must be MP3, WAV, M4A, or AAC.", { status: 415 });
  }
  const localPath = path.join(options.workDir, `background-music${extension}`);
  await downloadObjectToFile(options.objectKey, localPath);
  const probe = await probeVideo(localPath);
  if (!probe.hasAudio) throw new AppError("unsupported_media", "The background music file has no decodable audio stream.", { status: 415 });
  if (probe.sizeBytes > config.maxMusicUploadMb * 1024 * 1024) {
    throw new AppError("too_large", `Background music exceeds ${config.maxMusicUploadMb}MB.`, { status: 413 });
  }
  if (probe.durationSec > config.maxMusicDurationMinutes * 60) {
    throw new AppError("too_large", `Background music is longer than ${config.maxMusicDurationMinutes} minutes.`, { status: 413 });
  }
  let analysis: MusicEnergyAnalysis;
  try {
    analysis = await analyzeMusicEnergy(localPath);
  } catch {
    // Energy/tempo metadata is an optimization. A valid audio stream can still
    // be mixed safely with conservative defaults if analysis is unavailable.
    analysis = {
      durationSec: probe.durationSec,
      averageDb: null,
      peakTimesSec: [],
      estimatedBpm: null,
      vibe: "unknown",
    };
  }
  return { localPath, analysis };
}

/** Start just before an energy peak so the opening cut lands on that beat. */
export function musicOffsetForClip(analysis: MusicEnergyAnalysis, clipIndex: number): number {
  const usable = analysis.peakTimesSec.filter((time) => time >= 0.2 && time < Math.max(0.2, analysis.durationSec - 1));
  if (!usable.length) return 0;
  const peak = usable[clipIndex % usable.length];
  return Math.max(0, peak - 0.2);
}
