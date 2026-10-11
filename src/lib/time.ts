/** 01:02:03.456 (hours always shown when the media is an hour or longer). */
export function formatTime(t: number, withHours = false, msDigits = 3): string {
  if (!isFinite(t) || t < 0) t = 0;
  const totalMs = Math.round(t * 1000);
  const ms = totalMs % 1000;
  const s = Math.floor(totalMs / 1000) % 60;
  const m = Math.floor(totalMs / 60000) % 60;
  const h = Math.floor(totalMs / 3600000);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const frac = msDigits > 0 ? "." + pad(ms, 3).slice(0, msDigits) : "";
  if (h > 0 || withHours) return `${pad(h)}:${pad(m)}:${pad(s)}${frac}`;
  return `${pad(m)}:${pad(s)}${frac}`;
}

let secUnit = "s";
export function setSecondsUnit(unit: string) {
  secUnit = unit;
}

/** Human duration: "1:07.88", "12.5 s", "1:02:03". */
export function formatDuration(t: number): string {
  if (!isFinite(t) || t < 0) t = 0;
  if (t < 60) return `${t.toFixed(t < 10 ? 2 : 1)} ${secUnit}`;
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const ss = s.toFixed(1).padStart(4, "0");
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(Math.floor(s)).padStart(2, "0")}`;
  return `${m}:${ss}`;
}

/** Safe for file names: 00-01-23.456 → 00-01-23_456 */
export function fileTime(t: number): string {
  return formatTime(t, true, 3).replace(/:/g, "-").replace(".", "_");
}

/**
 * Parses "1:02:03.5", "02:03", "123.4", "1h2m3s" style input.
 * Returns null when it can't make sense of the string.
 */
export function parseTime(input: string): number | null {
  const s = input.trim().replace(",", ".");
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return parseFloat(s);
  const hms = /^(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+(?:\.\d+)?)s)?$/i.exec(s);
  if (hms && (hms[1] || hms[2] || hms[3])) {
    return (+(hms[1] ?? 0)) * 3600 + (+(hms[2] ?? 0)) * 60 + parseFloat(hms[3] ?? "0");
  }
  const parts = s.split(":");
  if (parts.length < 2 || parts.length > 3) return null;
  if (!parts.every((p) => /^\d+(\.\d+)?$/.test(p))) return null;
  const nums = parts.map(parseFloat);
  return nums.length === 3 ? nums[0] * 3600 + nums[1] * 60 + nums[2] : nums[0] * 60 + nums[1];
}

export function parseRate(r?: string): number | undefined {
  if (!r) return undefined;
  const [a, b] = r.split("/").map(Number);
  if (!b || !a || !isFinite(a / b)) return undefined;
  const v = a / b;
  return v > 0 && v < 1000 ? v : undefined;
}

export function formatBytes(n: number): string {
  if (!n) return "";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}
