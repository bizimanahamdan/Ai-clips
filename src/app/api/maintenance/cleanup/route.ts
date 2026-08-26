import { NextResponse } from "next/server";
import { config } from "@/lib/config";
import { runCleanup, ensureRuntime } from "@/lib/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Manual cleanup trigger. An in-process scheduler already runs this every
 * CLEANUP_INTERVAL_MINUTES; expose it so an external free cron (cron-job.org,
 * Vercel cron, uptime pinger) can also drive it.
 */
export async function POST() {
  await ensureRuntime();
  const result = await runCleanup();
  return NextResponse.json({
    ...result,
    retentionHours: config.retentionHours,
    at: new Date().toISOString(),
  });
}

export async function GET() {
  return POST();
}
