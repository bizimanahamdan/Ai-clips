import { NextResponse } from "next/server";
import { applyClipMusic, removeClipMusic } from "@/lib/clip-music";
import { AppError, toErrorPayload } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 900;

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const body = await request.json().catch(() => ({})) as { assetId?: string; volume?: number };
    if (!body.assetId) throw new AppError("bad_request", "Select a Media Library music asset.", { status: 400 });
    return NextResponse.json(await applyClipMusic(id, body.assetId, Number(body.volume ?? 0.12)));
  } catch (error) {
    const payload = toErrorPayload(error);
    return NextResponse.json({ error: payload.message, kind: payload.kind, detail: payload.detail }, { status: error instanceof AppError ? error.status : 500 });
  }
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    return NextResponse.json(await removeClipMusic(id));
  } catch (error) {
    const payload = toErrorPayload(error);
    return NextResponse.json({ error: payload.message, kind: payload.kind, detail: payload.detail }, { status: error instanceof AppError ? error.status : 500 });
  }
}
