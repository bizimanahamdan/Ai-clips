import path from "node:path";

const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".m4a", ".aac", ".ogg"]);
const AUDIO_MIME_TYPES = new Set([
  "audio/mpeg",
  "audio/mp3",
  "audio/x-mp3",
  "audio/mpeg3",
  "audio/x-mpeg",
  "audio/x-mpeg3",
  "audio/wav",
  "audio/wave",
  "audio/x-wav",
  "audio/vnd.wave",
  "audio/mp4",
  "audio/m4a",
  "audio/x-m4a",
  "audio/mp4a-latm",
  "audio/aac",
  "audio/aacp",
  "audio/x-aac",
  "audio/ogg",
  "application/ogg",
  "application/x-ogg",
]);
const GENERIC_MIME_TYPES = new Set([
  "",
  "application/octet-stream",
  "application/x-octet-stream",
  "binary/octet-stream",
  "application/binary",
  "application/x-binary",
  "application/x-download",
  "application/download",
  "application/force-download",
  "application/unknown",
]);

export type AudioUploadValidation = {
  accepted: boolean;
  extension: string;
  mimeType: string;
  usedExtensionFallback: boolean;
};

/**
 * Android content providers frequently report audio as generic binary data.
 * Trust a known audio MIME directly; otherwise use a supported filename
 * extension only for missing/generic MIME values. Explicit non-audio MIME
 * values stay rejected even if their filename was changed to end in .mp3.
 */
export function validateAudioUploadMetadata(fileName: string, rawMimeType: string | null): AudioUploadValidation {
  const extension = path.extname(fileName).toLowerCase();
  const mimeType = (rawMimeType || "").split(";", 1)[0].trim().toLowerCase();
  const supportedMime = AUDIO_MIME_TYPES.has(mimeType);
  const extensionFallback = GENERIC_MIME_TYPES.has(mimeType) && AUDIO_EXTENSIONS.has(extension);
  return {
    accepted: supportedMime || extensionFallback,
    extension,
    mimeType,
    usedExtensionFallback: !supportedMime && extensionFallback,
  };
}
