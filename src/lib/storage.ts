import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { config } from "./config";
import { AppError } from "./errors";

const PENDING_MARKER = "pending-upload";

export function storageRoot(): string {
  return config.storageDir;
}

export function uploadsRoot(): string {
  return path.join(storageRoot(), "uploads");
}

export function jobRoot(jobId: string): string {
  return path.join(storageRoot(), "jobs", jobId);
}

function safeSegment(segment: string): string {
  return segment.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
}

export function clipFileName(index: number, title: string): string {
  const slug = safeSegment(title)
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return `clip-${index + 1}${slug ? `-${slug}` : ""}.mp4`;
}

export async function ensureStorage(): Promise<void> {
  await fsp.mkdir(jobRoot(PENDING_MARKER), { recursive: true });
  await fsp.mkdir(uploadsRoot(), { recursive: true });
}

export async function createJobDir(jobId: string): Promise<string> {
  const dir = jobRoot(jobId);
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

export async function removePath(target: string): Promise<void> {
  await fsp.rm(target, { recursive: true, force: true });
}

export async function pathExists(target: string): Promise<boolean> {
  try {
    await fsp.access(target);
    return true;
  } catch {
    return false;
  }
}

export async function fileSize(target: string): Promise<number | null> {
  try {
    const stat = await fsp.stat(target);
    return stat.size;
  } catch {
    return null;
  }
}

/**
 * Fail fast when the disk is nearly full instead of dying halfway through a
 * render with a confusing ffmpeg error.
 */
export async function assertDiskSpace(requiredMb = config.minFreeDiskMb): Promise<void> {
  try {
    const stats = await fsp.statfs(storageRoot());
    const availableMb = (stats.bsize * Number(stats.bavail)) / (1024 * 1024);
    if (availableMb < requiredMb) {
      throw new AppError(
        "disk_full",
        `Not enough disk space to process video: ${Math.round(availableMb)}MB free, ${requiredMb}MB required.`,
        { status: 507 },
      );
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    // statfs unsupported on some filesystems — never block the job for this.
  }
}

/** Delete work dirs whose retention window has passed. Returns removed job ids. */
export async function purgeExpiredJobs(
  isExpired: (expiresAt: Date | null) => boolean,
): Promise<string[]> {
  const root = path.join(storageRoot(), "jobs");
  const removed: string[] = [];
  await fsp.mkdir(root, { recursive: true });
  const entries = await fsp.readdir(root, { withFileTypes: true });
  const now = Date.now();
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    try {
      const stat = await fsp.stat(dir);
      const expired = isExpired(new Date(stat.mtimeMs));
      const stale = now - stat.mtimeMs > 1000 * 60 * 60 * 24 * 2;
      if (expired || stale) {
        await removePath(dir);
        removed.push(entry.name);
      }
    } catch {
      /* ignore unreadable entries */
    }
  }
  // orphaned half-finished uploads
  try {
    const uploadDir = uploadsRoot();
    const uploads = await fsp.readdir(uploadDir, { withFileTypes: true });
    for (const entry of uploads) {
      const target = path.join(uploadDir, entry.name);
      const stat = await fsp.stat(target).catch(() => null);
      if (!stat) continue;
      if (now - stat.mtimeMs > 1000 * 60 * 60 * 12) {
        await removePath(target);
        removed.push(`upload:${entry.name}`);
      }
    }
  } catch {
    /* ignore */
  }
  return removed;
}

/** Writable check on startup so deployment problems surface immediately. */
export async function assertStorageWritable(): Promise<void> {
  await ensureStorage();
  const probe = path.join(storageRoot(), ".write-test");
  await fsp.writeFile(probe, String(Date.now()));
  await fsp.rm(probe, { force: true });
  if (!fs.existsSync(storageRoot())) {
    throw new AppError("internal", `Storage dir ${storageRoot()} is not usable.`);
  }
}
