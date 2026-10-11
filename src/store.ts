import { create } from "zustand";
import type {
  AppInfo,
  AudioPrep,
  ExportSettings,
  Fragment,
  KeyframeState,
  MediaFile,
  PreviewState,
  Toast,
  Track,
  Waveform,
} from "./lib/types";
import { defaultLang, type Lang } from "./i18n";
import { setSecondsUnit } from "./lib/time";

export type Theme = "light" | "dark";

interface Snapshot {
  tracks: Track[];
  fragments: Fragment[];
  activeId: string | null;
}

export interface State {
  lang: Lang;
  theme: Theme;
  appInfo: AppInfo | null;

  media: MediaFile | null;
  externals: Record<string, MediaFile>;
  tracks: Track[];
  fragments: Fragment[];
  activeId: string | null;

  keyframes: KeyframeState;
  waveforms: Record<string, Waveform>;
  preview: PreviewState;
  audioPrep: Record<string, AudioPrep>;

  currentTime: number;
  playing: boolean;
  rate: number;
  volume: number;
  muted: boolean;

  /** Timeline viewport: left edge in seconds and zoom in px/s. */
  view: { start: number; pps: number };
  timelineWidth: number;

  exportSettings: ExportSettings;
  exportOpen: boolean;
  helpOpen: boolean;
  dialog: null | { kind: "addAudio"; path: string } | { kind: "trackMeta"; trackId: string };

  toasts: Toast[];
  projectPath: string | null;
  dirty: boolean;
  loading: boolean;
  dragOver: boolean;

  past: Snapshot[];
  future: Snapshot[];
}

const emptyKeyframes: KeyframeState = { status: "none", progress: 0, times: new Float64Array(0), partial: [] };

function loadTheme(): Theme {
  const t = document.documentElement.dataset.theme;
  return t === "dark" ? "dark" : "light";
}

export const initialMediaState = (): Partial<State> => ({
  media: null,
  externals: {},
  tracks: [],
  fragments: [],
  activeId: null,
  keyframes: emptyKeyframes,
  waveforms: {},
  preview: { status: "idle", mode: "direct", progress: 0, url: null },
  audioPrep: {},
  currentTime: 0,
  playing: false,
  view: { start: 0, pps: 0 },
  projectPath: null,
  dirty: false,
  past: [],
  future: [],
});

const initialLang = defaultLang();
setSecondsUnit(initialLang === "ru" ? "с" : "s");

export const useStore = create<State>(() => ({
  lang: initialLang,
  theme: loadTheme(),
  appInfo: null,

  media: null,
  externals: {},
  tracks: [],
  fragments: [],
  activeId: null,

  keyframes: emptyKeyframes,
  waveforms: {},
  preview: { status: "idle", mode: "direct", progress: 0, url: null },
  audioPrep: {},

  currentTime: 0,
  playing: false,
  rate: 1,
  volume: 1,
  muted: false,

  view: { start: 0, pps: 0 },
  timelineWidth: 800,

  exportSettings: {
    dir: "",
    container: "source",
    template: "{name}_{n}",
    mergeTemplate: "{name}_cut",
    mode: "separate",
    faststart: true,
  },
  exportOpen: false,
  helpOpen: false,
  dialog: null,

  toasts: [],
  projectPath: null,
  dirty: false,
  loading: false,
  dragOver: false,

  past: [],
  future: [],
}));

export const get = useStore.getState;
export const set = useStore.setState;

// ---------------------------------------------------------------------------
// History (undo / redo) for edits to tracks and fragments
// ---------------------------------------------------------------------------

function snapshot(): Snapshot {
  const s = get();
  return { tracks: s.tracks, fragments: s.fragments, activeId: s.activeId };
}

/** Records the current state so the next change can be undone. */
export function checkpoint() {
  const s = get();
  set({ past: [...s.past.slice(-99), snapshot()], future: [], dirty: true });
}

/** Applies an edit with an undo checkpoint. */
export function commit(patch: Partial<Pick<State, "tracks" | "fragments" | "activeId">>) {
  checkpoint();
  set(patch);
}

function restore(snap: Snapshot) {
  // Monitoring (audible) is not an edit: keep what the user is listening to.
  const audible = new Map(get().tracks.map((t) => [t.id, t.audible]));
  set({
    tracks: snap.tracks.map((t) => (audible.has(t.id) ? { ...t, audible: audible.get(t.id)! } : t)),
    fragments: snap.fragments,
    activeId: snap.activeId,
    dirty: true,
  });
}

export function undo() {
  const s = get();
  const prev = s.past[s.past.length - 1];
  if (!prev) return;
  const cur = snapshot();
  set({ past: s.past.slice(0, -1), future: [...s.future, cur] });
  restore(prev);
}

export function redo() {
  const s = get();
  const next = s.future[s.future.length - 1];
  if (!next) return;
  const cur = snapshot();
  set({ future: s.future.slice(0, -1), past: [...s.past, cur] });
  restore(next);
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

let toastSeq = 0;
export function toast(text: string, kind: Toast["kind"] = "info", ms = 4200) {
  toastSeq += 1;
  const id = toastSeq;
  set({ toasts: [...get().toasts.slice(-3), { id, kind, text }] });
  window.setTimeout(() => set({ toasts: get().toasts.filter((x) => x.id !== id) }), ms);
}

export function setTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem("nee.theme", theme);
  } catch {
    /* ignore */
  }
  set({ theme });
}

export function setLang(lang: Lang) {
  try {
    localStorage.setItem("nee.lang", lang);
  } catch {
    /* ignore */
  }
  document.documentElement.lang = lang;
  setSecondsUnit(lang === "ru" ? "с" : "s");
  set({ lang });
}

export function updateTrack(id: string, patch: Partial<Track>, record = true) {
  const tracks = get().tracks.map((t) => (t.id === id ? { ...t, ...patch } : t));
  if (record) commit({ tracks });
  else set({ tracks });
}

export function wfKey(filePath: string, streamIndex: number) {
  return `${filePath}|${streamIndex}`;
}

export function sortedFragments(fragments: Fragment[]): Fragment[] {
  return [...fragments].sort((a, b) => a.start - b.start || (a.end ?? Infinity) - (b.end ?? Infinity));
}

export function fragmentNumber(fragments: Fragment[], id: string): number {
  return sortedFragments(fragments).findIndex((f) => f.id === id) + 1;
}

export function hasVideoTrack(tracks: Track[]) {
  return tracks.some((t) => t.kind === "video" && t.source === "main");
}
