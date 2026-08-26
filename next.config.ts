import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // FFmpeg binary packages must stay outside the bundle: they resolve their own
  // binary path with __dirname, which bundlers rewrite.
  serverExternalPackages: ["ffmpeg-static", "ffprobe-static"],
};

export default nextConfig;
