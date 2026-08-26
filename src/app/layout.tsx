import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "ClipForge — AI vertical clip generator",
  description:
    "Upload a long video, get vertical 9:16 clips with AI-picked moments and burned-in captions.",
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
