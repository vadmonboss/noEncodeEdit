// Downloads the FFmpeg build that ships with noEncodeEdit into
// src-tauri/resources/ffmpeg (BtbN n9.0 win64 GPL shared build).
// Usage: npm run fetch-ffmpeg [-- --force]
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PINNED = {
  url: "https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-10-10-13-04/ffmpeg-n9.0.2-25-g67b60c310b-win64-gpl-shared-9.0.zip",
  sha256: "353cebf22561a21d2b89dedca873d11a7dff4bcb21f4cbed09567506c9762972",
};
// BtbN prunes old autobuilds; fall back to the rolling n9.0 build if needed.
const FALLBACK = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n9.0-latest-win64-gpl-shared-9.0.zip";

const FILES = [
  "ffmpeg.exe",
  "ffprobe.exe",
  "avcodec-63.dll",
  "avdevice-63.dll",
  "avfilter-12.dll",
  "avformat-63.dll",
  "avutil-61.dll",
  "swresample-7.dll",
  "swscale-10.dll",
];

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dest = join(root, "src-tauri", "resources", "ffmpeg");

if (!process.argv.includes("--force") && FILES.every((f) => existsSync(join(dest, f)))) {
  console.log("FFmpeg already present in", dest, "(use --force to re-download)");
  process.exit(0);
}

async function download(url) {
  console.log("Downloading", url);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

let zip;
try {
  zip = await download(PINNED.url);
  const hash = createHash("sha256").update(zip).digest("hex");
  if (hash !== PINNED.sha256) throw new Error(`SHA-256 mismatch: ${hash}`);
  console.log("SHA-256 verified");
} catch (e) {
  console.warn(`Pinned build unavailable (${e.message}); using the rolling n9.0 build instead.`);
  zip = await download(FALLBACK);
}

const work = mkdtempSync(join(tmpdir(), "nee-ffmpeg-"));
try {
  const zipPath = join(work, "ffmpeg.zip");
  writeFileSync(zipPath, zip);
  // tar.exe (bsdtar) ships with Windows 10 1803+ and extracts zip archives.
  execFileSync("tar", ["-xf", zipPath, "-C", work], { stdio: "inherit" });
  const top = readdirSync(work).find((d) => d.startsWith("ffmpeg-"));
  if (!top) throw new Error("unexpected archive layout");
  mkdirSync(dest, { recursive: true });
  for (const f of FILES) cpSync(join(work, top, "bin", f), join(dest, f));
  cpSync(join(work, top, "LICENSE.txt"), join(dest, "FFMPEG-LICENSE.txt"));
  console.log("FFmpeg ready in", dest);
} finally {
  rmSync(work, { recursive: true, force: true });
}
