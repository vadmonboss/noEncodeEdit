import type { MediaFile, ProbeResult, ProbeStream, Track } from "./types";
import { parseRate } from "./time";

// ---------------------------------------------------------------------------
// Display names
// ---------------------------------------------------------------------------

const CODEC_NAMES: Record<string, string> = {
  h264: "H.264",
  hevc: "H.265",
  av1: "AV1",
  vp8: "VP8",
  vp9: "VP9",
  mpeg4: "MPEG-4",
  mpeg2video: "MPEG-2",
  mpeg1video: "MPEG-1",
  prores: "ProRes",
  dnxhd: "DNxHD",
  mjpeg: "MJPEG",
  vvc: "H.266",
  wmv3: "WMV9",
  vc1: "VC-1",
  aac: "AAC",
  mp3: "MP3",
  mp2: "MP2",
  ac3: "AC-3",
  eac3: "E-AC-3",
  dts: "DTS",
  truehd: "TrueHD",
  opus: "Opus",
  vorbis: "Vorbis",
  flac: "FLAC",
  alac: "ALAC",
  wmav2: "WMA",
  subrip: "SRT",
  ass: "ASS",
  ssa: "SSA",
  mov_text: "MP4 Text",
  webvtt: "WebVTT",
  hdmv_pgs_subtitle: "PGS",
  dvd_subtitle: "VobSub",
  dvb_subtitle: "DVB",
};

export function codecName(codec: string): string {
  if (CODEC_NAMES[codec]) return CODEC_NAMES[codec];
  if (codec.startsWith("pcm_")) return "PCM";
  return codec.toUpperCase();
}

export function channelsLabel(ch?: number, layout?: string): string {
  if (!ch) return "";
  if (layout?.includes("5.1")) return "5.1";
  if (layout?.includes("7.1")) return "7.1";
  if (ch === 1) return "mono";
  if (ch === 2) return "2.0";
  return `${ch}ch`;
}

// ---------------------------------------------------------------------------
// Containers
// ---------------------------------------------------------------------------

export interface ContainerInfo {
  ext: string;
  muxer: string;
  label: string;
  video: boolean;
}

export const VIDEO_CONTAINERS: ContainerInfo[] = [
  { ext: "mp4", muxer: "mp4", label: "MP4", video: true },
  { ext: "mkv", muxer: "matroska", label: "MKV", video: true },
  { ext: "mov", muxer: "mov", label: "MOV", video: true },
  { ext: "webm", muxer: "webm", label: "WebM", video: true },
  { ext: "ts", muxer: "mpegts", label: "TS", video: true },
];

export const AUDIO_CONTAINERS: ContainerInfo[] = [
  { ext: "m4a", muxer: "ipod", label: "M4A", video: false },
  { ext: "mka", muxer: "matroska", label: "MKA", video: false },
  { ext: "mp3", muxer: "mp3", label: "MP3", video: false },
  { ext: "flac", muxer: "flac", label: "FLAC", video: false },
  { ext: "ogg", muxer: "ogg", label: "OGG", video: false },
  { ext: "opus", muxer: "opus", label: "Opus", video: false },
  { ext: "wav", muxer: "wav", label: "WAV", video: false },
  { ext: "ac3", muxer: "ac3", label: "AC3", video: false },
  { ext: "aac", muxer: "adts", label: "AAC", video: false },
];

const EXT_MUXER: Record<string, string> = {
  mp4: "mp4",
  m4v: "mp4",
  mov: "mov",
  mkv: "matroska",
  mk3d: "matroska",
  mka: "matroska",
  webm: "webm",
  ts: "mpegts",
  mts: "mpegts",
  m2ts: "mpegts",
  avi: "avi",
  flv: "flv",
  "3gp": "3gp",
  wmv: "asf",
  asf: "asf",
  mpg: "mpeg",
  mpeg: "mpeg",
  vob: "vob",
  m4a: "ipod",
  m4b: "ipod",
  mp3: "mp3",
  flac: "flac",
  ogg: "ogg",
  oga: "ogg",
  opus: "opus",
  wav: "wav",
  ac3: "ac3",
  eac3: "eac3",
  aac: "adts",
  wma: "asf",
};

export function muxerForExt(ext: string): string | null {
  return EXT_MUXER[ext.toLowerCase()] ?? null;
}

/** Resolves the export container ("source" → source extension). */
export function resolveContainer(choice: string, source: MediaFile, hasVideo: boolean): ContainerInfo {
  const list = hasVideo ? VIDEO_CONTAINERS : AUDIO_CONTAINERS;
  if (choice !== "source") {
    const found = [...VIDEO_CONTAINERS, ...AUDIO_CONTAINERS].find((c) => c.ext === choice);
    if (found) return found;
  }
  const ext = source.ext;
  const muxer = muxerForExt(ext);
  if (muxer) {
    // A video file exported audio-only keeps a sensible audio container.
    if (!hasVideo && ["mp4", "m4v", "mov"].includes(ext)) return AUDIO_CONTAINERS[0];
    if (!hasVideo && ["mkv", "webm"].includes(ext)) return AUDIO_CONTAINERS[1];
    return { ext, muxer, label: ext.toUpperCase(), video: hasVideo };
  }
  return list[1];
}

// ---------------------------------------------------------------------------
// Static compatibility hints (the real check is an ffmpeg dry run)
// ---------------------------------------------------------------------------

const ANY = "*";
const COMPAT: Record<string, { video: string[]; audio: string[]; subtitle: string[] }> = {
  mp4: {
    video: ["h264", "hevc", "av1", "vp9", "mpeg4", "mpeg2video", "mpeg1video", "mjpeg", "vvc", "png"],
    audio: ["aac", "mp3", "mp2", "ac3", "eac3", "opus", "flac", "alac", "dts", "truehd", "pcm_s16le", "pcm_s24le", "pcm_s32le", "pcm_f32le"],
    subtitle: ["mov_text"],
  },
  mov: {
    video: ["h264", "hevc", "av1", "vp9", "mpeg4", "mpeg2video", "mjpeg", "prores", "dnxhd", "png", "qtrle", "rawvideo"],
    audio: ["aac", "mp3", "ac3", "eac3", "alac", "opus", "flac", "pcm_s16le", "pcm_s16be", "pcm_s24le", "pcm_s24be", "pcm_f32le"],
    subtitle: ["mov_text"],
  },
  ipod: { video: [], audio: ["aac", "alac", "ac3", "eac3", "mp3"], subtitle: ["mov_text"] },
  matroska: { video: [ANY], audio: [ANY], subtitle: ["subrip", "ass", "ssa", "webvtt", "hdmv_pgs_subtitle", "dvd_subtitle", "dvb_subtitle", "text"] },
  webm: { video: ["vp8", "vp9", "av1"], audio: ["opus", "vorbis"], subtitle: ["webvtt"] },
  mpegts: {
    video: ["h264", "hevc", "mpeg2video", "mpeg1video", "mpeg4", "av1", "vvc"],
    audio: ["aac", "mp3", "mp2", "ac3", "eac3", "dts", "opus", "truehd"],
    subtitle: ["dvb_subtitle", "dvb_teletext"],
  },
  mp3: { video: [], audio: ["mp3"], subtitle: [] },
  flac: { video: [], audio: ["flac"], subtitle: [] },
  ogg: { video: [], audio: ["vorbis", "opus", "flac", "speex"], subtitle: [] },
  opus: { video: [], audio: ["opus"], subtitle: [] },
  wav: { video: [], audio: ["pcm_s16le", "pcm_s24le", "pcm_s32le", "pcm_f32le", "pcm_u8", "mp3", "ac3"], subtitle: [] },
  ac3: { video: [], audio: ["ac3"], subtitle: [] },
  adts: { video: [], audio: ["aac"], subtitle: [] },
};

/** null = unknown (let the dry run decide). */
export function staticCompatible(muxer: string, track: Pick<Track, "kind" | "codec">): boolean | null {
  const entry = COMPAT[muxer];
  if (!entry) return null;
  const list = entry[track.kind];
  if (list.includes(ANY)) return true;
  return list.includes(track.codec);
}

// ---------------------------------------------------------------------------
// What the WebView can play natively
// ---------------------------------------------------------------------------

export const NATIVE_AUDIO_CODECS = new Set(["aac", "mp3", "opus", "vorbis", "flac"]);
const NATIVE_AUDIO_FILE_EXT = new Set(["mp3", "m4a", "aac", "ogg", "oga", "opus", "flac", "wav", "webm", "mp4"]);
const NATIVE_PCM = new Set(["pcm_s16le", "pcm_s24le", "pcm_f32le", "pcm_u8"]);
export const REMUXABLE_VIDEO = new Set(["h264", "hevc", "av1", "vp8", "vp9"]);

/** Can this audio file be played as-is by <audio>? */
export function audioFileNativelyPlayable(ext: string, codec: string): boolean {
  if (!NATIVE_AUDIO_FILE_EXT.has(ext)) return false;
  if (ext === "wav") return NATIVE_PCM.has(codec);
  return NATIVE_AUDIO_CODECS.has(codec);
}

// ---------------------------------------------------------------------------
// Probe → MediaFile / Tracks
// ---------------------------------------------------------------------------

export function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

export function dirName(path: string): string {
  const i = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return i > 0 ? path.slice(0, i) : path;
}

export function stem(path: string): string {
  const b = baseName(path);
  const i = b.lastIndexOf(".");
  return i > 0 ? b.slice(0, i) : b;
}

export function extOf(path: string): string {
  const b = baseName(path);
  const i = b.lastIndexOf(".");
  return i > 0 ? b.slice(i + 1).toLowerCase() : "";
}

export function joinPath(dir: string, name: string): string {
  if (!dir) return name;
  return dir.endsWith("\\") || dir.endsWith("/") ? dir + name : `${dir}\\${name}`;
}

function num(v?: string): number {
  const n = v ? parseFloat(v) : NaN;
  return isFinite(n) ? n : 0;
}

export function toMediaFile(path: string, probe: ProbeResult): MediaFile {
  const f = probe.format;
  const streams = probe.streams.filter((s) => !isAttachedPic(s));
  let duration = num(f.duration);
  if (!duration) {
    duration = Math.max(0, ...streams.map((s) => num(s.duration)));
  }
  return {
    path,
    name: baseName(path),
    ext: extOf(path),
    formatName: f.format_name,
    formatLong: f.format_long_name ?? f.format_name,
    duration,
    startTime: num(f.start_time),
    size: num(f.size),
    bitRate: num(f.bit_rate),
    streams,
  };
}

function isAttachedPic(s: ProbeStream): boolean {
  return s.codec_type === "video" && s.disposition?.attached_pic === 1;
}

let trackSeq = 0;
export function newTrackId(): string {
  trackSeq += 1;
  return `t${Date.now().toString(36)}${trackSeq}`;
}

export function streamToTrack(file: MediaFile, s: ProbeStream, source: "main" | "external"): Track | null {
  const kind = s.codec_type as Track["kind"];
  if (kind !== "video" && kind !== "audio" && kind !== "subtitle") return null;
  const lang = s.tags?.language ?? s.tags?.LANGUAGE ?? "";
  const title = s.tags?.title ?? s.tags?.TITLE ?? "";
  const start = num(s.start_time) - file.startTime;
  const duration = num(s.duration) || file.duration;
  return {
    id: newTrackId(),
    kind,
    source,
    filePath: file.path,
    fileName: file.name,
    streamIndex: s.index,
    codec: s.codec_name ?? "unknown",
    codecLong: s.codec_long_name ?? s.codec_name ?? "",
    profile: s.profile,
    width: s.width,
    height: s.height,
    fps: parseRate(s.avg_frame_rate) ?? parseRate(s.r_frame_rate),
    channels: s.channels,
    channelLayout: s.channel_layout,
    sampleRate: s.sample_rate ? parseInt(s.sample_rate, 10) : undefined,
    bitRate: s.bit_rate ? parseInt(s.bit_rate, 10) : undefined,
    origLanguage: lang === "und" ? "" : lang,
    origTitle: title,
    language: lang === "und" ? "" : lang,
    title,
    enabled: true,
    audible: false,
    offset: 0,
    duration,
    startTime: Math.max(0, start),
  };
}

/** Builds main tracks: video first, then audio, then subtitles (ffprobe order inside each group). */
export function tracksFromMedia(file: MediaFile): Track[] {
  const out: Track[] = [];
  for (const kind of ["video", "audio", "subtitle"] as const) {
    for (const s of file.streams) {
      if (s.codec_type !== kind) continue;
      const t = streamToTrack(file, s, "main");
      if (t) out.push(t);
    }
  }
  const firstAudio = out.find((t) => t.kind === "audio");
  if (firstAudio) firstAudio.audible = true;
  return out;
}

export function primaryVideo(tracks: Track[]): Track | undefined {
  return tracks.find((t) => t.kind === "video" && t.source === "main");
}

export function trackLabel(t: Track): string {
  const bits = [codecName(t.codec)];
  if (t.kind === "video") {
    if (t.width && t.height) bits.push(`${t.width}×${t.height}`);
    if (t.fps) bits.push(`${Math.round(t.fps * 100) / 100} fps`);
  } else if (t.kind === "audio") {
    const ch = channelsLabel(t.channels, t.channelLayout);
    if (ch) bits.push(ch);
    if (t.sampleRate) bits.push(`${Math.round(t.sampleRate / 100) / 10} kHz`);
  }
  return bits.join(" · ");
}

/**
 * Seek behaviour of the source container for stream-copy cuts.
 * ffmpeg pulls `-ss` back by 3/23 s when a stream has B-frames and the
 * demuxer can't seek by pts (everything except the MOV/MP4 family); without
 * compensation a cut placed on a keyframe would start one GOP early.
 */
export function seekQuirks(file: MediaFile): { seekPreroll: number; genpts: boolean; combinedSeek: boolean } {
  const fmt = file.formatName.toLowerCase().split(",");
  const movFamily = fmt.some((f) => f === "mov" || f === "mp4");
  const bFrames = file.streams.some((s) => (s.has_b_frames ?? 0) > 0);
  const genpts = fmt.some((f) => f === "avi" || f === "mpeg");
  // MPEG-TS / PS can't seek onto a keyframe; pick it by timestamp instead.
  const combinedSeek = fmt.some((f) => f === "mpegts" || f === "mpeg" || f === "mpegvideo");
  return { seekPreroll: !movFamily && !combinedSeek && bFrames ? 3 / 23 : 0, genpts, combinedSeek };
}

/** Combined seeking margin before keyframe `k`: covers B-frame delay, below half a GOP. */
export function seekMargin(keyframes: ArrayLike<number>, k: number): number {
  let prev = -Infinity;
  for (let i = 0; i < keyframes.length; i++) {
    if (keyframes[i] < k - 0.0005) prev = keyframes[i];
    else break;
  }
  const gapHalf = isFinite(prev) ? (k - prev) / 2 : k;
  return Math.max(0, Math.min(0.25, gapHalf));
}
