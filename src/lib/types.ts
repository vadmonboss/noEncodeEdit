export type StreamKind = "video" | "audio" | "subtitle";

export interface ProbeStream {
  index: number;
  codec_type: string;
  codec_name?: string;
  codec_long_name?: string;
  profile?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  pix_fmt?: string;
  has_b_frames?: number;
  sample_rate?: string;
  channels?: number;
  channel_layout?: string;
  bit_rate?: string;
  duration?: string;
  start_time?: string;
  tags?: Record<string, string>;
  disposition?: Record<string, number>;
}

export interface ProbeResult {
  streams: ProbeStream[];
  format: {
    filename: string;
    format_name: string;
    format_long_name?: string;
    duration?: string;
    start_time?: string;
    size?: string;
    bit_rate?: string;
    tags?: Record<string, string>;
  };
}

export interface MediaFile {
  path: string;
  name: string;
  /** lower-case extension without dot */
  ext: string;
  formatName: string;
  formatLong: string;
  duration: number;
  startTime: number;
  size: number;
  bitRate: number;
  streams: ProbeStream[];
}

export interface Track {
  id: string;
  kind: StreamKind;
  source: "main" | "external";
  filePath: string;
  fileName: string;
  streamIndex: number;
  codec: string;
  codecLong: string;
  profile?: string;
  width?: number;
  height?: number;
  fps?: number;
  channels?: number;
  channelLayout?: string;
  sampleRate?: number;
  bitRate?: number;
  origLanguage: string;
  origTitle: string;
  language: string;
  title: string;
  /** Included in export. */
  enabled: boolean;
  /** Played back while previewing. */
  audible: boolean;
  /** External tracks: where the file's 0:00 sits on the source timeline (s). */
  offset: number;
  /** Stream duration (s). */
  duration: number;
  /** Stream start relative to its file start (s). */
  startTime: number;
  /** When an external track replaces an original one. */
  replacesId?: string;
}

export interface Fragment {
  id: string;
  /** In point, seconds from file start. */
  start: number;
  /** Out point; null while the fragment is still being marked. */
  end: number | null;
  label: string;
}

export interface Waveform {
  pps: number;
  peaks: Uint8Array;
  length: number;
  progress: number;
  done: boolean;
  error?: string;
}

export interface PreviewState {
  status: "idle" | "loading" | "ready" | "preparing" | "error";
  mode: "direct" | "remux" | "transcode" | "audio";
  progress: number;
  url: string | null;
  error?: string;
}

export interface AudioPrep {
  status: "idle" | "preparing" | "ready" | "error";
  progress: number;
  url?: string;
  error?: string;
}

export interface KeyframeState {
  status: "none" | "loading" | "ready" | "error";
  progress: number;
  /** Sorted, relative to file start. */
  times: Float64Array;
  /** Partial results from local lookups while the full scan runs. */
  partial: number[];
}

export type ExportMode = "separate" | "merge";

export interface ExportSettings {
  dir: string;
  container: string; // "source" or an extension
  template: string;
  mergeTemplate: string;
  mode: ExportMode;
  faststart: boolean;
}

export interface Toast {
  id: number;
  kind: "info" | "success" | "warn" | "error";
  text: string;
}

export interface AppInfo {
  ffmpegPath: string;
  ffmpegVersion: string;
  tempDir: string;
  launchFile: string | null;
  version: string;
}
