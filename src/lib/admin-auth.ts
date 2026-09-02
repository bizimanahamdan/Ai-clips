import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "./config";
import { AppError } from "./errors";

export const ADMIN_COOKIE = "clipforge_admin";

function token(): string {
  return createHmac("sha256", config.adminPassword).update("clipforge:r2-admin:v1").digest("hex");
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function adminConfigured(): boolean {
  return config.adminPassword.length >= 12;
}

export function verifyAdminPassword(password: string): boolean {
  return adminConfigured() && safeEqual(password, config.adminPassword);
}

export function requireAdmin(request: Request): void {
  if (!adminConfigured()) {
    throw new AppError("internal", "Admin storage access is not configured.", {
      detail: "Set a strong ADMIN_PASSWORD with at least 12 characters.",
      status: 503,
    });
  }
  const cookies = request.headers.get("cookie") ?? "";
  const value = cookies.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${ADMIN_COOKIE}=`))?.slice(ADMIN_COOKIE.length + 1);
  if (!value || !safeEqual(value, token())) {
    throw new AppError("not_found", "Admin authorization required.", { status: 401 });
  }
}

export function adminCookieValue(): string {
  return token();
}
