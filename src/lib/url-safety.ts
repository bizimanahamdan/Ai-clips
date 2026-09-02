import dns from "node:dns/promises";
import net from "node:net";
import { AppError } from "./errors";

const BLOCKED_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".home", ".lan"];

function blockedIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b, c] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function blockedIp(address: string): boolean {
  const normalized = address.toLowerCase().split("%")[0];
  if (net.isIPv4(normalized)) return blockedIpv4(normalized);
  if (!net.isIPv6(normalized)) return true;
  if (normalized.startsWith("::ffff:")) {
    const mapped = normalized.slice("::ffff:".length);
    return net.isIPv4(mapped) ? blockedIpv4(mapped) : true;
  }
  return (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    /^fe[89ab]/.test(normalized) ||
    normalized.startsWith("ff") ||
    normalized.startsWith("2001:db8:")
  );
}

/**
 * Validate scheme, credentials, hostname and every resolved address. Call this
 * again for each redirect so a public URL cannot redirect to cloud metadata or
 * an internal service.
 */
export async function validatePublicVideoUrl(value: string | URL): Promise<URL> {
  let url: URL;
  try {
    url = value instanceof URL ? new URL(value.href) : new URL(value);
  } catch {
    throw new AppError("bad_request", "The video URL is not valid.", { status: 400 });
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new AppError("bad_request", "Only public HTTP or HTTPS video URLs are supported.", { status: 400 });
  }
  if (url.username || url.password) {
    throw new AppError("bad_request", "Video URLs containing embedded credentials are not allowed.", { status: 400 });
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
  if (!hostname || hostname === "localhost" || BLOCKED_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) {
    throw new AppError("bad_request", "Local or internal-network video URLs are not allowed.", { status: 400 });
  }

  let addresses: string[];
  if (net.isIP(hostname)) {
    addresses = [hostname];
  } else {
    try {
      addresses = (await dns.lookup(hostname, { all: true, verbatim: true })).map((item) => item.address);
    } catch (error) {
      throw new AppError("download_failed", "The video URL hostname could not be resolved.", {
        detail: (error as Error).message,
        status: 400,
      });
    }
  }
  if (!addresses.length || addresses.some(blockedIp)) {
    throw new AppError("bad_request", "The video URL resolves to a private, reserved, or unsafe network address.", {
      status: 400,
    });
  }
  return url;
}
