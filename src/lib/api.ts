import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { AppInfo, ProbeResult } from "./types";

export const CANCELLED = "__cancelled__";

export interface PreparedMedia {
  path: string;
  url: string;
}

export interface ExportTrackSpec {
  input: number;
  streamIndex: number;
  kind: string;
  offset: number;
  language?: string | null;
  title?: string | null;
  default: boolean;
}

export interface ExportFragmentSpec {
  start: number;
  end: number;
  videoStart: number;
  outPath: string;
  seekMargin?: number;
}

export interface ExportSpec {
  inputs: string[];
  tracks: ExportTrackSpec[];
  fragments: ExportFragmentSpec[];
  format: string;
  faststart: boolean;
  mergePath?: string | null;
  seekPreroll?: number;
  genpts?: boolean;
  combinedSeek?: boolean;
}

export interface CompatResult {
  ok: boolean;
  error: string | null;
  tracks: { ok: boolean; error: string | null }[];
}

let jobSeq = 0;
export function newJobId(prefix: string): string {
  jobSeq += 1;
  return `${prefix}-${Date.now().toString(36)}-${jobSeq}`;
}

export function errText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

export const api = {
  appInfo: () => invoke<AppInfo>("app_info"),
  probe: (path: string) => invoke<ProbeResult>("probe", { path }),
  mediaUrl: (path: string) => invoke<string>("media_url", { path }),
  scanKeyframes: (jobId: string, path: string, streamIndex: number, duration: number) =>
    invoke<number[]>("scan_keyframes", { jobId, path, streamIndex, duration }),
  keyframesAround: (path: string, streamIndex: number, time: number, before = 20, after = 20) =>
    invoke<number[]>("keyframes_around", { path, streamIndex, time, before, after }),
  waveform: (jobId: string, path: string, streamIndex: number, duration: number) =>
    invoke<{ pps: number; peaks: number[] }>("waveform", { jobId, path, streamIndex, duration }),
  prepareAudioPreview: (jobId: string, path: string, streamIndex: number, codec: string, duration: number) =>
    invoke<PreparedMedia>("prepare_audio_preview", { jobId, path, streamIndex, codec, duration }),
  prepareVideoPreview: (
    jobId: string,
    path: string,
    streamIndex: number,
    codec: string,
    mode: "remux" | "transcode",
    duration: number,
  ) => invoke<PreparedMedia>("prepare_video_preview", { jobId, path, streamIndex, codec, mode, duration }),
  exportFragments: (jobId: string, spec: ExportSpec) =>
    invoke<{ files: string[] }>("export_fragments", { jobId, spec }),
  testCompat: (spec: ExportSpec, extension: string) => invoke<CompatResult>("test_compat", { spec, extension }),
  cancelJob: (jobId: string) => invoke<void>("cancel_job", { jobId }),
  pathsExist: (paths: string[]) => invoke<boolean[]>("paths_exist", { paths }),
  readText: (path: string) => invoke<string>("read_text", { path }),
  writeText: (path: string, content: string) => invoke<void>("write_text", { path, content }),
  revealPath: (path: string) => invoke<void>("reveal_path", { path }),
  openUrl: (url: string) => invoke<void>("open_url", { url }),
};

export interface JobProgressEvent {
  jobId: string;
  progress: number;
}
export interface WaveChunkEvent {
  jobId: string;
  offset: number;
  peaks: number[];
  progress: number;
}
export interface ExportProgressEvent {
  jobId: string;
  index: number;
  fraction: number;
  overall: number;
}

type Handler<T> = (payload: T) => void;
const handlers = {
  progress: new Map<string, Handler<JobProgressEvent>>(),
  wave: new Map<string, Handler<WaveChunkEvent>>(),
  export: new Map<string, Handler<ExportProgressEvent>>(),
};

let unlisteners: UnlistenFn[] = [];
export async function initEvents() {
  if (unlisteners.length) return;
  unlisteners = await Promise.all([
    listen<JobProgressEvent>("job-progress", (e) => handlers.progress.get(e.payload.jobId)?.(e.payload)),
    listen<WaveChunkEvent>("waveform-chunk", (e) => handlers.wave.get(e.payload.jobId)?.(e.payload)),
    listen<ExportProgressEvent>("export-progress", (e) => handlers.export.get(e.payload.jobId)?.(e.payload)),
  ]);
}

export function onJobProgress(jobId: string, h: Handler<JobProgressEvent>) {
  handlers.progress.set(jobId, h);
  return () => handlers.progress.delete(jobId);
}
export function onWaveChunk(jobId: string, h: Handler<WaveChunkEvent>) {
  handlers.wave.set(jobId, h);
  return () => handlers.wave.delete(jobId);
}
export function onExportProgress(jobId: string, h: Handler<ExportProgressEvent>) {
  handlers.export.set(jobId, h);
  return () => handlers.export.delete(jobId);
}
