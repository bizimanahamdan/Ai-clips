import { config } from "./config";

export const OUTPUT_FORMATS = ["9:16", "1:1", "16:9"] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

export function normalizeOutputFormat(value: unknown): OutputFormat {
  return OUTPUT_FORMATS.includes(value as OutputFormat) ? (value as OutputFormat) : "9:16";
}

export function outputDimensions(format: OutputFormat): { width: number; height: number } {
  if (format === "1:1") return { width: config.squareSize, height: config.squareSize };
  if (format === "16:9") return { width: config.landscapeWidth, height: config.landscapeHeight };
  return { width: config.targetWidth, height: config.targetHeight };
}
