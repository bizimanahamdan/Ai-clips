import { NextResponse } from "next/server";
import { ADMIN_COOKIE, adminConfigured, adminCookieValue, verifyAdminPassword } from "@/lib/admin-auth";

export const runtime = "nodejs";

export async function POST(request: Request) {
  if (!adminConfigured()) return NextResponse.json({ error: "Admin access is not configured." }, { status: 503 });
  const body = await request.json().catch(() => ({})) as { password?: string };
  if (!verifyAdminPassword(body.password ?? "")) {
    return NextResponse.json({ error: "Invalid admin password." }, { status: 401 });
  }
  const response = NextResponse.json({ authenticated: true });
  response.cookies.set(ADMIN_COOKIE, adminCookieValue(), {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 8 * 60 * 60,
  });
  return response;
}

export async function DELETE() {
  const response = NextResponse.json({ authenticated: false });
  response.cookies.set(ADMIN_COOKIE, "", { httpOnly: true, sameSite: "strict", path: "/", maxAge: 0 });
  return response;
}
