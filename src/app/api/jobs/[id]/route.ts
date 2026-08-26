import { NextResponse } from "next/server";
import { AppError, toErrorPayload } from "@/lib/errors";
import { deleteJob, ensureRuntime, getJob } from "@/lib/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await ensureRuntime();
    const { id } = await context.params;
    const job = await getJob(id);
    if (!job) throw new AppError("not_found", `Job ${id} not found. It may have been cleaned up.`, { status: 404 });
    return NextResponse.json({ job });
  } catch (error) {
    const payload = toErrorPayload(error);
    return NextResponse.json(
      { error: payload.message, kind: payload.kind },
      { status: error instanceof AppError ? error.status : 500 },
    );
  }
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await ensureRuntime();
    const { id } = await context.params;
    await deleteJob(id);
    return NextResponse.json({ deleted: true });
  } catch (error) {
    const payload = toErrorPayload(error);
    return NextResponse.json(
      { error: payload.message, kind: payload.kind },
      { status: error instanceof AppError ? error.status : 500 },
    );
  }
}
