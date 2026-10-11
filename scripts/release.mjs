// Builds the app and assembles release/ with a portable folder, a zip of it,
// the NSIS installer and SHA256SUMS.txt.  Usage: npm run release
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const conf = JSON.parse(readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8"));
const version = conf.version;
const repoUrl = (readFileSync(join(root, "src", "lib", "about.ts"), "utf8").match(/"(https:[^"]+)"/) ?? [])[1] ?? "";
const run = (cmd) => execSync(cmd, { cwd: root, stdio: "inherit" });

if (!process.argv.includes("--skip-build")) run("npx tauri build");

const target = join(root, "src-tauri", "target", "release");
const exe = ["noEncodeEdit.exe", "noencodeedit.exe"].map((n) => join(target, n)).find(existsSync);
if (!exe) throw new Error("built exe not found in " + target);

const release = join(root, "release");
const portableDir = join(release, "portable", "noEncodeEdit");
const installerDir = join(release, "installer");
rmSync(release, { recursive: true, force: true });
mkdirSync(portableDir, { recursive: true });
mkdirSync(installerDir, { recursive: true });

// Portable: exe + ffmpeg next to it (the app looks for ./ffmpeg first).
cpSync(exe, join(portableDir, "noEncodeEdit.exe"));
cpSync(join(root, "src-tauri", "resources", "ffmpeg"), join(portableDir, "ffmpeg"), { recursive: true });
writeFileSync(
  join(portableDir, "README.txt"),
  [
    `noEncodeEdit ${version} — portable edition`,
    "",
    "Run noEncodeEdit.exe. No installation needed. Keep the ffmpeg folder next to the exe.",
    "Requires Microsoft Edge WebView2 Runtime (built into Windows 11, usually present on Windows 10).",
    "",
    "noEncodeEdit is free software under the GNU GPL v3 or later.",
    `Source code and updates: ${repoUrl}`,
    "FFmpeg (GPL v3) — see ffmpeg/FFMPEG-LICENSE.txt",
    "",
  ].join("\r\n"),
  "utf8",
);

// Zip of the portable folder.
const zip = join(release, `noEncodeEdit_${version}_x64_portable.zip`);
execSync(`tar -a -c -f "${zip}" -C "${join(release, "portable")}" noEncodeEdit`, { stdio: "inherit" });

// Installer.
const nsisDir = join(target, "bundle", "nsis");
for (const f of existsSync(nsisDir) ? readdirSync(nsisDir) : []) {
  if (f.toLowerCase().endsWith(".exe") && f.includes(version)) cpSync(join(nsisDir, f), join(installerDir, f));
}

// Checksums for the downloadable assets.
const assets = [zip, ...readdirSync(installerDir).map((f) => join(installerDir, f))];
const sums = assets.map((p) => `${createHash("sha256").update(readFileSync(p)).digest("hex")}  ${basename(p)}`);
writeFileSync(join(release, "SHA256SUMS.txt"), sums.join("\n") + "\n", "utf8");

console.log("\nRelease assembled in", release);
for (const p of [portableDir, installerDir]) console.log(" -", p, readdirSync(p).join(", "));
console.log(" -", zip);
console.log(sums.join("\n"));
