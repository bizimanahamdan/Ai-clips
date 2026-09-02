/**
 * Lower edge of the preferred duration range for a selected maximum.
 * A 45-second selection targets 25–45 seconds. MIN_CLIP_SEC remains only the
 * fallback floor; it is not the normal target.
 */
export function preferredClipMin(maxSec: number, fallbackMinSec: number): number {
  const maximum = Math.max(1, maxSec);
  const fallback = Math.min(maximum, Math.max(1, fallbackMinSec));
  if (maximum <= fallback + 1) return fallback;
  return Math.min(maximum - 1, Math.max(fallback, Math.round(maximum * (25 / 45))));
}
