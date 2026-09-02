import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "ClipForge — AI clip generator",
  description:
    "Create AI-picked clips in multiple formats with captions and reusable media-library audio.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  themeColor: "#0b1020",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh bg-[#070b16] text-slate-100 antialiased selection:bg-indigo-500/40">
        <div className="mx-auto w-full max-w-xl px-4 pb-24 pt-6">{children}</div>
      </body>
    </html>
  );
}
