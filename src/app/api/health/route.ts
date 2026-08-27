import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { checkBinaries } from "@/lib/ffmpeg";
import { providersConfigured } from "@/lib/config";
import { ensureRuntime, queueSnapshot } from "@/lib/jobs";
import { storageRoot } from "@/lib/storage";
import { checkR2 } from "@/lib/object-storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const checks: Record<string, unknown> = {};
  let ok = true;

  try {
    await db.execute(sql`select 1`);
    checks.database = "ok";
  } catch (error) {
    ok = false;
    checks.database = `error: ${(error as Error).message}`;
  }

  try {
    const binaries = await checkBinaries();
    checks.ffmpeg = binaries;
  } catch (error) {
    ok = false;
    checks.ffmpeg = `error: ${(error as Error).message}`;
  }

  try {
    const providers = providersConfigured();
    checks.providers = {
      groq: providers.groq ? "configured" : "missing GROQ_API_KEY",
      openrouter: providers.openrouter ? "configured" : "missing OPENROUTER_API_KEY",
      order: providers.order,
    };
    if (!providers.order.length) ok = false;
  } catch (error) {
    checks.providers = `error: ${(error as Error).message}`;
  }

  checks.temporaryStorage = storageRoot();

  try {
    checks.r2 = await checkR2();
  } catch (error) {
    ok = false;
    checks.r2 = `error: ${(error as Error).message}`;
  }

  try {
    await ensureRuntime();
    checks.queue = queueSnapshot();
  } catch (error) {
    ok = false;
    checks.queue = `error: ${(error as Error).message}`;
  }

  return NextResponse.json(
    { status: ok ? "ok" : "degraded", checks, timestamp: new Date().toISOString() },
    { status: ok ? 200 : 503 },
  );
}
