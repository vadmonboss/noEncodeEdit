/** App actions with side effects: opening files, background jobs, marking, projects. */
import { ask, open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  api,
  CANCELLED,
  errText,
  newJobId,
  onJobProgress,
  onWaveChunk,
} from "./lib/api";
import {
  audioFileNativelyPlayable,
  baseName,
  dirName,
  primaryVideo,
  REMUXABLE_VIDEO,
  streamToTrack,
  toMediaFile,
  tracksFromMedia,
} from "./lib/media";
import { keyframeAtOrBefore, mergeSorted, nearest } from "./lib/keyframes";
import type { AudioPrep, Fragment, MediaFile, Track } from "./lib/types";
import { engine } from "./engine";
import { t } from "./i18n";
import {
  checkpoint,
  commit,
  get,
  hasVideoTrack,
  initialMediaState,
  set,
  sortedFragments,
  toast,
  wfKey,
} from "./store";
import { formatTime } from "./lib/time";

export const MEDIA_EXTENSIONS = [
  "mp4", "m4v", "mov", "mkv", "webm", "avi", "ts", "mts", "m2ts", "flv", "wmv", "mpg", "mpeg", "vob", "3gp", "ogv",
  "mp3", "m4a", "m4b", "aac", "ac3", "eac3", "dts", "flac", "wav", "ogg", "oga", "opus", "wma", "mka", "mp2", "thd",
];
export const AUDIO_EXTENSIONS = [
  "mp3", "m4a", "aac", "ac3", "eac3", "dts", "flac", "wav", "ogg", "oga", "opus", "wma", "mka", "mp2", "thd",
  "mp4", "mkv", "mov", "webm",
];

// ---------------------------------------------------------------------------
// Background jobs
// ---------------------------------------------------------------------------

const runningJobs = new Set<string>();
let generation = 0; // bumps on every newly opened file

function trackJob(id: string) {
  runningJobs.add(id);
  return () => runningJobs.delete(id);
}

function cancelAllJobs() {
  for (const id of runningJobs) void api.cancelJob(id).catch(() => {});
  runningJobs.clear();
  waveQueue.length = 0;
}

// ---------------------------------------------------------------------------
// Opening media
// ---------------------------------------------------------------------------

export async function confirmDiscard(): Promise<boolean> {
  const s = get();
  if (!s.dirty || !s.media) return true;
  return ask(t("msg.unsaved"), { title: "noEncodeEdit", kind: "warning" });
}

export async function pickAndOpenMedia() {
  const path = await openDialog({
    multiple: false,
    directory: false,
    filters: [{ name: "Media", extensions: MEDIA_EXTENSIONS }, { name: "*", extensions: ["*"] }],
  });
  if (typeof path === "string") await openMedia(path);
}

export async function openMedia(path: string, opts: { skipConfirm?: boolean } = {}): Promise<boolean> {
  if (!opts.skipConfirm && !(await confirmDiscard())) return false;
  cancelAllJobs();
  engine.reset();
  generation += 1;
  const gen = generation;
  set({ ...initialMediaState(), loading: true });

  let media: MediaFile;
  try {
    media = toMediaFile(path, await api.probe(path));
  } catch (e) {
    set({ loading: false });
    toast(`${t("msg.probeFailed")}: ${errText(e)}`, "error", 8000);
    return false;
  }
  if (gen !== generation) return false;
  const tracks = tracksFromMedia(media);
  if (!tracks.some((x) => x.kind === "video" || x.kind === "audio")) {
    set({ loading: false });
    toast(t("msg.noVideo"), "error");
    return false;
  }

  set({
    loading: false,
    media,
    tracks,
    exportSettings: { ...get().exportSettings, dir: dirName(path) },
  });
  fitView();
  addRecent(path);
  updateTitle();

  void loadPreview(gen);
  void scanKeyframes(gen);
  for (const tr of tracks) if (tr.kind === "audio") ensureWaveform(tr);
  return true;
}

export async function closeMedia() {
  if (!(await confirmDiscard())) return;
  cancelAllJobs();
  engine.reset();
  generation += 1;
  set({ ...initialMediaState() });
  updateTitle();
}

async function loadPreview(gen: number) {
  const { media, tracks } = get();
  if (!media) return;
  const video = primaryVideo(tracks);
  const setPreview = (p: Partial<ReturnType<typeof get>["preview"]>) => {
    if (gen === generation) set({ preview: { ...get().preview, ...p } });
  };

  try {
    if (video) {
      setPreview({ status: "loading", mode: "direct", progress: 0 });
      const direct = await api.mediaUrl(media.path);
      let r = await engine.loadMaster(direct, true);
      if (gen !== generation) return;
      if (r === "ok") return setPreview({ status: "ready", mode: "direct", url: direct });

      // Container unreadable but codec fine → cheap remux; codec unsupported → transcode.
      if (r === "error" && REMUXABLE_VIDEO.has(video.codec)) {
        const p = await prepareVideo(gen, video, "remux", setPreview);
        if (p) {
          r = await engine.loadMaster(p, true);
          if (gen !== generation) return;
          if (r === "ok") return setPreview({ status: "ready", mode: "remux", url: p });
        }
      }
      const p2 = await prepareVideo(gen, video, "transcode", setPreview);
      if (!p2) return;
      r = await engine.loadMaster(p2, true);
      if (gen !== generation) return;
      if (r === "ok") return setPreview({ status: "ready", mode: "transcode", url: p2 });
      engine.clearMaster();
      setPreview({ status: "error", error: t("player.previewFailed") });
    } else {
      const audio = tracks.find((x) => x.kind === "audio")!;
      const single = media.streams.filter((s) => s.codec_type === "audio").length === 1;
      setPreview({ status: "loading", mode: "audio", progress: 0 });
      if (single && audioFileNativelyPlayable(media.ext, audio.codec)) {
        const url = await api.mediaUrl(media.path);
        const r = await engine.loadMaster(url, false);
        if (gen !== generation) return;
        if (r === "ok") return setPreview({ status: "ready", url });
      }
      setPreview({ status: "preparing", progress: 0 });
      const jobId = newJobId("pa");
      const untrack = trackJob(jobId);
      const off = onJobProgress(jobId, (p) => setPreview({ progress: p.progress }));
      try {
        const prep = await api.prepareAudioPreview(jobId, media.path, audio.streamIndex, audio.codec, media.duration);
        if (gen !== generation) return;
        const r = await engine.loadMaster(prep.url, false);
        if (r === "ok") return setPreview({ status: "ready", url: prep.url });
        setPreview({ status: "error", error: t("player.previewFailed") });
      } finally {
        off();
        untrack();
      }
    }
  } catch (e) {
    if (errText(e) === CANCELLED || gen !== generation) return;
    setPreview({ status: "error", error: `${t("player.previewFailed")} (${errText(e)})` });
  }
}

async function prepareVideo(
  gen: number,
  video: Track,
  mode: "remux" | "transcode",
  setPreview: (p: Partial<ReturnType<typeof get>["preview"]>) => void,
): Promise<string | null> {
  const media = get().media!;
  const jobId = newJobId("pv");
  const untrack = trackJob(jobId);
  setPreview({ status: "preparing", mode, progress: 0 });
  const off = onJobProgress(jobId, (p) => setPreview({ progress: p.progress }));
  try {
    const r = await api.prepareVideoPreview(jobId, media.path, video.streamIndex, video.codec, mode, media.duration);
    return gen === generation ? r.url : null;
  } catch (e) {
    if (errText(e) === CANCELLED) return null;
    if (mode === "transcode") setPreview({ status: "error", error: `${t("player.previewFailed")} (${errText(e)})` });
    return null;
  } finally {
    off();
    untrack();
  }
}

// ---------------------------------------------------------------------------
// Keyframes
// ---------------------------------------------------------------------------

async function scanKeyframes(gen: number) {
  const { media, tracks } = get();
  const video = primaryVideo(tracks);
  if (!media || !video) return;
  const jobId = newJobId("kf");
  const untrack = trackJob(jobId);
  set({ keyframes: { ...get().keyframes, status: "loading", progress: 0 } });
  const off = onJobProgress(jobId, (p) => {
    if (gen === generation) set({ keyframes: { ...get().keyframes, progress: p.progress } });
  });
  try {
    const abs = await api.scanKeyframes(jobId, media.path, video.streamIndex, media.duration + media.startTime);
    if (gen !== generation) return;
    const rel = Float64Array.from(abs.map((x) => Math.max(0, x - media.startTime)));
    set({ keyframes: { status: "ready", progress: 1, times: rel, partial: [] } });
  } catch (e) {
    if (errText(e) === CANCELLED || gen !== generation) return;
    set({ keyframes: { ...get().keyframes, status: "error" } });
    toast(`${t("msg.kfScanFailed")}: ${errText(e)}`, "warn");
  } finally {
    off();
    untrack();
  }
}

/** Keyframe list usable right now (full scan or local lookups so far). */
export function knownKeyframes(): ArrayLike<number> {
  const k = get().keyframes;
  return k.status === "ready" ? k.times : k.partial;
}

/** Makes sure keyframes around `time` are known (fast local lookup). */
async function ensureKeyframesNear(time: number): Promise<ArrayLike<number>> {
  const s = get();
  if (s.keyframes.status === "ready") return s.keyframes.times;
  const video = primaryVideo(s.tracks);
  if (!s.media || !video) return [];
  try {
    const abs = await api.keyframesAround(s.media.path, video.streamIndex, time + s.media.startTime, 30, 30);
    const rel = abs.map((x) => Math.max(0, x - s.media!.startTime));
    const merged = mergeSorted(get().keyframes.partial, rel);
    if (get().keyframes.status !== "ready") set({ keyframes: { ...get().keyframes, partial: merged } });
    return get().keyframes.status === "ready" ? get().keyframes.times : merged;
  } catch {
    return knownKeyframes();
  }
}

export async function snapToKeyframe(time: number): Promise<number> {
  if (!hasVideoTrack(get().tracks)) return time;
  const times = await ensureKeyframesNear(time);
  return nearest(times, time) ?? time;
}

/** Where the video of a fragment really starts when cut without re-encoding. */
export async function actualStart(start: number): Promise<number> {
  if (!hasVideoTrack(get().tracks)) return start;
  const times = await ensureKeyframesNear(start);
  return keyframeAtOrBefore(times, start) ?? start;
}

export function actualStartSync(start: number): number | null {
  if (!hasVideoTrack(get().tracks)) return start;
  const times = knownKeyframes();
  if (times.length === 0) return null;
  return keyframeAtOrBefore(times, start);
}

// ---------------------------------------------------------------------------
// Waveforms
// ---------------------------------------------------------------------------

const waveQueue: (() => Promise<void>)[] = [];
let waveActive = 0;

function pumpWaves() {
  while (waveActive < 2 && waveQueue.length) {
    const job = waveQueue.shift()!;
    waveActive += 1;
    void job().finally(() => {
      waveActive -= 1;
      pumpWaves();
    });
  }
}

export function peaksPerSecond(duration: number): number {
  const target = duration > 0 ? 160000 / duration : 100;
  const options = [10, 16, 20, 25, 32, 40, 50, 80, 100];
  for (let i = options.length - 1; i >= 0; i--) if (options[i] <= target) return options[i];
  return 10;
}

export function ensureWaveform(track: Track) {
  const key = wfKey(track.filePath, track.streamIndex);
  if (get().waveforms[key]) return;
  const gen = generation;
  const duration = track.duration || get().media?.duration || 0;
  const pps = peaksPerSecond(duration);
  const capacity = Math.ceil(duration * pps) + pps * 4 + 16;
  let buf = new Uint8Array(capacity);
  let length = 0;
  const setWave = (patch: Partial<ReturnType<typeof get>["waveforms"][string]>) => {
    if (gen !== generation) return;
    const cur = get().waveforms[key];
    set({ waveforms: { ...get().waveforms, [key]: { ...cur, ...patch } } });
  };
  set({ waveforms: { ...get().waveforms, [key]: { pps, peaks: buf, length: 0, progress: 0, done: false } } });

  waveQueue.push(async () => {
    if (gen !== generation) return;
    const jobId = newJobId("wf");
    const untrack = trackJob(jobId);
    const off = onWaveChunk(jobId, (c) => {
      const end = c.offset + c.peaks.length;
      if (end > buf.length) {
        const bigger = new Uint8Array(Math.max(end, buf.length * 2));
        bigger.set(buf);
        buf = bigger;
      }
      buf.set(c.peaks, c.offset);
      length = Math.max(length, end);
      setWave({ peaks: buf, length, progress: c.progress });
    });
    try {
      const r = await api.waveform(jobId, track.filePath, track.streamIndex, duration);
      const peaks = Uint8Array.from(r.peaks);
      setWave({ pps: r.pps, peaks, length: peaks.length, progress: 1, done: true });
    } catch (e) {
      if (errText(e) !== CANCELLED) setWave({ done: true, error: errText(e) });
    } finally {
      off();
      untrack();
    }
  });
  pumpWaves();
}

// ---------------------------------------------------------------------------
// Audio for listening
// ---------------------------------------------------------------------------

function setPrep(key: string, p: AudioPrep) {
  set({ audioPrep: { ...get().audioPrep, [key]: p } });
}

export async function ensureAudioPrep(track: Track) {
  const key = wfKey(track.filePath, track.streamIndex);
  const cur = get().audioPrep[key];
  if (cur && cur.status !== "idle") return;
  const gen = generation;
  setPrep(key, { status: "preparing", progress: 0 });
  const file = track.source === "main" ? get().media : get().externals[track.filePath];
  if (!file) return;
  try {
    const firstAudio = file.streams.find((s) => s.codec_type === "audio");
    let url: string;
    if (
      track.source === "external" &&
      firstAudio?.index === track.streamIndex &&
      !file.streams.some((s) => s.codec_type === "video") &&
      audioFileNativelyPlayable(file.ext, track.codec)
    ) {
      url = await api.mediaUrl(track.filePath);
    } else {
      const jobId = newJobId("ap");
      const untrack = trackJob(jobId);
      const off = onJobProgress(jobId, (p) => {
        if (gen === generation) setPrep(key, { status: "preparing", progress: p.progress });
      });
      try {
        const r = await api.prepareAudioPreview(jobId, track.filePath, track.streamIndex, track.codec, track.duration || file.duration);
        url = r.url;
      } finally {
        off();
        untrack();
      }
    }
    if (gen === generation) setPrep(key, { status: "ready", progress: 1, url });
  } catch (e) {
    if (gen !== generation) return;
    if (errText(e) === CANCELLED) {
      setPrep(key, { status: "idle", progress: 0 });
      return;
    }
    setPrep(key, { status: "error", progress: 0, error: errText(e) });
    toast(`${t("tracks.audioError")}: ${errText(e)}`, "warn");
  }
}

engine.requestAudio = (track) => queueMicrotask(() => void ensureAudioPrep(track));

// ---------------------------------------------------------------------------
// External audio tracks
// ---------------------------------------------------------------------------

export async function pickExternalAudio(replaceId?: string) {
  const res = await openDialog({
    multiple: !replaceId,
    directory: false,
    filters: [{ name: "Audio", extensions: AUDIO_EXTENSIONS }, { name: "*", extensions: ["*"] }],
  });
  const paths = typeof res === "string" ? [res] : Array.isArray(res) ? res : [];
  for (const p of paths) await addExternalAudio(p, replaceId);
}

export async function addExternalAudio(path: string, replaceId?: string): Promise<boolean> {
  const s = get();
  if (!s.media) return false;
  let file: MediaFile;
  try {
    file = s.externals[path] ?? toMediaFile(path, await api.probe(path));
  } catch (e) {
    toast(`${t("msg.probeFailed")}: ${errText(e)}`, "error", 8000);
    return false;
  }
  const audioStreams = file.streams.filter((x) => x.codec_type === "audio");
  if (audioStreams.length === 0) {
    toast(t("tracks.noAudioInFile", { name: file.name }), "warn");
    return false;
  }
  set({ externals: { ...get().externals, [path]: file } });

  const newTracks: Track[] = [];
  for (const st of audioStreams) {
    const tr = streamToTrack(file, st, "external");
    if (!tr) continue;
    tr.startTime = 0;
    newTracks.push(tr);
  }
  let tracks = [...get().tracks];
  if (replaceId) {
    const idx = tracks.findIndex((x) => x.id === replaceId);
    const old = tracks[idx];
    if (idx >= 0 && old) {
      const first = newTracks[0];
      first.replacesId = old.id;
      first.audible = old.audible;
      if (!first.language && old.language) first.language = old.language;
      tracks[idx] = { ...old, enabled: false, audible: false };
      tracks.splice(idx, 0, ...newTracks);
    }
  } else {
    // After the last audio track.
    let insertAt = tracks.length;
    for (let i = tracks.length - 1; i >= 0; i--) {
      if (tracks[i].kind === "audio") {
        insertAt = i + 1;
        break;
      }
      if (tracks[i].kind === "video") insertAt = i + 1;
    }
    tracks.splice(insertAt, 0, ...newTracks);
  }
  commit({ tracks });
  for (const tr of newTracks) ensureWaveform(tr);
  toast(t("tracks.added", { name: file.name }), "success", 2600);
  return true;
}

export function removeTrack(id: string) {
  const s = get();
  const tr = s.tracks.find((x) => x.id === id);
  if (!tr || tr.source !== "external") return;
  const tracks = s.tracks
    .filter((x) => x.id !== id)
    .map((x) => (x.id === tr.replacesId ? { ...x, enabled: true } : x));
  commit({ tracks });
}

export function moveTrack(id: string, dir: -1 | 1) {
  const tracks = [...get().tracks];
  const i = tracks.findIndex((x) => x.id === id);
  if (i < 0) return;
  const kind = tracks[i].kind;
  let j = i + dir;
  while (j >= 0 && j < tracks.length && tracks[j].kind !== kind) j += dir;
  if (j < 0 || j >= tracks.length) return;
  [tracks[i], tracks[j]] = [tracks[j], tracks[i]];
  commit({ tracks });
}

// ---------------------------------------------------------------------------
// Marking
// ---------------------------------------------------------------------------

let fragSeq = 0;
function newFragmentId() {
  fragSeq += 1;
  return `f${Date.now().toString(36)}${fragSeq}`;
}

function activeFragment(): Fragment | undefined {
  const s = get();
  return s.fragments.find((f) => f.id === s.activeId);
}

export async function markIn(free = false) {
  const s = get();
  if (!s.media) return;
  const t0 = s.currentTime;
  const start = free ? t0 : await snapToKeyframe(t0);
  const draft = activeFragment();
  if (draft && draft.end === null) {
    commit({ fragments: get().fragments.map((f) => (f.id === draft.id ? { ...f, start } : f)) });
  } else {
    const id = newFragmentId();
    commit({ fragments: [...get().fragments, { id, start, end: null, label: "" }], activeId: id });
  }
  if (!get().playing && Math.abs(start - t0) > 0.0005) engine.seek(start);
}

export function markOut() {
  const s = get();
  if (!s.media) return;
  const tNow = s.currentTime;
  const cur = activeFragment();
  if (cur) {
    if (tNow <= cur.start + 0.01) {
      toast(t("frag.outBeforeIn"), "warn", 2500);
      return;
    }
    commit({ fragments: s.fragments.map((f) => (f.id === cur.id ? { ...f, end: tNow } : f)) });
    return;
  }
  // Nothing selected: fragment from the previous end (or the beginning) to here.
  const prevEnd = Math.max(0, ...s.fragments.map((f) => (f.end !== null && f.end <= tNow ? f.end : 0)));
  if (tNow <= prevEnd + 0.01) {
    toast(t("frag.outBeforeIn"), "warn", 2500);
    return;
  }
  const id = newFragmentId();
  commit({ fragments: [...s.fragments, { id, start: prevEnd, end: tNow, label: "" }], activeId: id });
  if (prevEnd > 0) void snapToKeyframe(prevEnd).then((k) => k !== prevEnd && setFragmentStart(id, k, false));
}

export async function setSelectedEdge(edge: "start" | "end", free = false) {
  const s = get();
  const cur = activeFragment();
  if (!cur) {
    toast(t("frag.selectFirst"), "info", 2200);
    return;
  }
  const tNow = s.currentTime;
  if (edge === "start") {
    const v = free ? tNow : await snapToKeyframe(tNow);
    if (cur.end !== null && v >= cur.end - 0.01) return toast(t("frag.outBeforeIn"), "warn", 2500);
    commit({ fragments: get().fragments.map((f) => (f.id === cur.id ? { ...f, start: v } : f)) });
  } else {
    if (tNow <= cur.start + 0.01) return toast(t("frag.outBeforeIn"), "warn", 2500);
    commit({ fragments: get().fragments.map((f) => (f.id === cur.id ? { ...f, end: tNow } : f)) });
  }
}

export function setFragmentStart(id: string, start: number, record = true) {
  const fragments = get().fragments.map((f) => (f.id === id ? { ...f, start } : f));
  if (record) commit({ fragments });
  else set({ fragments, dirty: true });
}

export function updateFragment(id: string, patch: Partial<Fragment>, record = true) {
  const fragments = get().fragments.map((f) => (f.id === id ? { ...f, ...patch } : f));
  if (record) commit({ fragments });
  else set({ fragments, dirty: true });
}

export function deleteFragment(id?: string) {
  const s = get();
  const target = id ?? s.activeId;
  if (!target) return;
  const order = sortedFragments(s.fragments);
  const idx = order.findIndex((f) => f.id === target);
  const fragments = s.fragments.filter((f) => f.id !== target);
  const next = order[idx + 1] ?? order[idx - 1];
  commit({ fragments, activeId: s.activeId === target ? (next && next.id !== target ? next.id : null) : s.activeId });
}

export function selectFragment(id: string | null, seekTo?: "start" | "end") {
  set({ activeId: id });
  const f = get().fragments.find((x) => x.id === id);
  if (f && seekTo) engine.seek(seekTo === "start" ? f.start : (f.end ?? f.start));
}

export function playFragment(id: string) {
  const f = get().fragments.find((x) => x.id === id);
  if (!f) return;
  set({ activeId: id });
  engine.seek(f.start);
  engine.play(f.end ?? undefined);
}

/** All marks (fragment edges) for ↑/↓ navigation, plus file edges and keyframes are separate. */
export function boundaries(): number[] {
  const s = get();
  const pts = new Set<number>([0]);
  if (s.media) pts.add(s.media.duration);
  for (const f of s.fragments) {
    pts.add(f.start);
    if (f.end !== null) pts.add(f.end);
  }
  return [...pts].sort((a, b) => a - b);
}

export function jumpBoundary(dir: -1 | 1) {
  const cur = get().currentTime;
  const b = boundaries();
  const target = dir > 0 ? b.find((x) => x > cur + 0.0005) : [...b].reverse().find((x) => x < cur - 0.0005);
  if (target !== undefined) engine.seek(target);
}

export async function jumpKeyframe(dir: -1 | 1) {
  const cur = get().currentTime;
  const times = await ensureKeyframesNear(cur);
  let target: number | undefined;
  if (dir > 0) {
    for (let i = 0; i < times.length; i++) if (times[i] > cur + 0.002) { target = times[i]; break; }
  } else {
    for (let i = times.length - 1; i >= 0; i--) if (times[i] < cur - 0.002) { target = times[i]; break; }
  }
  if (target !== undefined) {
    engine.pause();
    engine.seek(target);
  }
}

// ---------------------------------------------------------------------------
// Timeline view
// ---------------------------------------------------------------------------

export function fitView() {
  const s = get();
  const d = s.media?.duration ?? 0;
  const w = Math.max(100, s.timelineWidth);
  set({ view: { start: 0, pps: d > 0 ? w / d : 50 } });
}

export function clampView(start: number, pps: number) {
  const s = get();
  const d = s.media?.duration ?? 0;
  const w = Math.max(100, s.timelineWidth);
  const minPps = d > 0 ? w / d : 1;
  const p = Math.min(4000, Math.max(minPps, pps));
  const visible = w / p;
  const st = Math.max(0, Math.min(Math.max(0, d - visible), start));
  return { start: st, pps: p };
}

export function zoomAt(factor: number, anchorTime?: number) {
  const s = get();
  const w = s.timelineWidth;
  const anchor = anchorTime ?? s.currentTime;
  const ax = (anchor - s.view.start) * s.view.pps;
  const pps = s.view.pps * factor;
  const v = clampView(anchor - (Math.max(0, Math.min(w, ax)) / pps), pps);
  set({ view: v });
}

// ---------------------------------------------------------------------------
// Projects (.nee)
// ---------------------------------------------------------------------------

interface ProjectFile {
  app: "noEncodeEdit";
  version: 1;
  source: string;
  tracks: Array<{
    source: "main" | "external";
    filePath: string;
    streamIndex: number;
    enabled: boolean;
    audible: boolean;
    offset: number;
    language: string;
    title: string;
    replacesStream?: number;
  }>;
  fragments: Array<{ start: number; end: number | null; label: string }>;
  export: { dir: string; container: string; template: string; mergeTemplate: string; mode: string; faststart: boolean };
}

export async function saveProject(saveAs = false) {
  const s = get();
  if (!s.media) return;
  let path = s.projectPath;
  if (!path || saveAs) {
    const picked = await saveDialog({
      defaultPath: `${s.media.path.replace(/\.[^.\\/]+$/, "")}.nee`,
      filters: [{ name: "noEncodeEdit", extensions: ["nee"] }],
    });
    if (!picked) return;
    path = picked.toLowerCase().endsWith(".nee") ? picked : `${picked}.nee`;
  }
  const byId = new Map(s.tracks.map((x) => [x.id, x]));
  const data: ProjectFile = {
    app: "noEncodeEdit",
    version: 1,
    source: s.media.path,
    tracks: s.tracks.map((x) => ({
      source: x.source,
      filePath: x.filePath,
      streamIndex: x.streamIndex,
      enabled: x.enabled,
      audible: x.audible,
      offset: x.offset,
      language: x.language,
      title: x.title,
      replacesStream: x.replacesId ? byId.get(x.replacesId)?.streamIndex : undefined,
    })),
    fragments: sortedFragments(s.fragments).map((f) => ({ start: f.start, end: f.end, label: f.label })),
    export: { ...s.exportSettings },
  };
  try {
    await api.writeText(path, JSON.stringify(data, null, 2));
    set({ projectPath: path, dirty: false });
    updateTitle();
    toast(t("msg.projectSaved"), "success", 2200);
  } catch (e) {
    toast(errText(e), "error");
  }
}

export async function pickAndOpenProject() {
  const path = await openDialog({ multiple: false, filters: [{ name: "noEncodeEdit", extensions: ["nee"] }] });
  if (typeof path === "string") await openProject(path);
}

export async function openProject(path: string) {
  if (!(await confirmDiscard())) return;
  let data: ProjectFile;
  try {
    data = JSON.parse(await api.readText(path));
    if (data.app !== "noEncodeEdit" || !data.source) throw new Error("bad");
  } catch {
    toast(t("msg.projectBad"), "error");
    return;
  }
  const [exists] = await api.pathsExist([data.source]);
  if (!exists) {
    toast(t("msg.projectMissing", { path: data.source }), "error", 8000);
    return;
  }
  if (!(await openMedia(data.source, { skipConfirm: true }))) return;

  // Externals first (probe), then rebuild the track list in saved order.
  const externals = data.tracks.filter((x) => x.source === "external");
  const paths = [...new Set(externals.map((x) => x.filePath))];
  const existing = await api.pathsExist(paths);
  const files: Record<string, MediaFile> = {};
  for (let i = 0; i < paths.length; i++) {
    if (!existing[i]) {
      toast(t("msg.projectMissing", { path: paths[i] }), "warn", 8000);
      continue;
    }
    try {
      files[paths[i]] = toMediaFile(paths[i], await api.probe(paths[i]));
    } catch (e) {
      toast(`${baseName(paths[i])}: ${errText(e)}`, "warn");
    }
  }

  const s = get();
  const mainByStream = new Map(s.tracks.map((x) => [x.streamIndex, x]));
  const rebuilt: Track[] = [];
  const used = new Set<string>();
  for (const pt of data.tracks) {
    if (pt.source === "main") {
      const tr = mainByStream.get(pt.streamIndex);
      if (!tr) continue;
      rebuilt.push({ ...tr, enabled: pt.enabled, audible: pt.audible, language: pt.language, title: pt.title });
      used.add(tr.id);
    } else {
      const file = files[pt.filePath];
      const st = file?.streams.find((x) => x.index === pt.streamIndex);
      if (!file || !st) continue;
      const tr = streamToTrack(file, st, "external");
      if (!tr) continue;
      tr.startTime = 0;
      Object.assign(tr, { enabled: pt.enabled, audible: pt.audible, offset: pt.offset, language: pt.language, title: pt.title });
      if (pt.replacesStream !== undefined) tr.replacesId = mainByStream.get(pt.replacesStream)?.id;
      rebuilt.push(tr);
    }
  }
  for (const tr of s.tracks) if (!used.has(tr.id)) rebuilt.push(tr);

  const fragments: Fragment[] = data.fragments.map((f) => ({ id: newFragmentId(), start: f.start, end: f.end, label: f.label ?? "" }));
  set({
    externals: files,
    tracks: rebuilt,
    fragments,
    activeId: fragments[0]?.id ?? null,
    exportSettings: { ...get().exportSettings, ...data.export, mode: data.export?.mode === "merge" ? "merge" : "separate" },
    projectPath: path,
    dirty: false,
    past: [],
    future: [],
  });
  for (const tr of rebuilt) if (tr.kind === "audio") ensureWaveform(tr);
  updateTitle();
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

export function updateTitle() {
  const s = get();
  const parts = ["noEncodeEdit"];
  if (s.media) parts.unshift(`${s.media.name}${s.dirty ? " •" : ""}`);
  void getCurrentWindow().setTitle(parts.join(" — ")).catch(() => {});
}

export interface RecentItem {
  path: string;
  name: string;
  time: number;
}

export function loadRecent(): RecentItem[] {
  try {
    const raw = JSON.parse(localStorage.getItem("nee.recent") ?? "[]");
    return Array.isArray(raw) ? raw.slice(0, 6) : [];
  } catch {
    return [];
  }
}

function addRecent(path: string) {
  try {
    const list = loadRecent().filter((r) => r.path !== path);
    list.unshift({ path, name: baseName(path), time: Date.now() });
    localStorage.setItem("nee.recent", JSON.stringify(list.slice(0, 6)));
  } catch {
    /* ignore */
  }
}

export function removeRecent(path: string) {
  try {
    localStorage.setItem("nee.recent", JSON.stringify(loadRecent().filter((r) => r.path !== path)));
  } catch {
    /* ignore */
  }
}

export async function handleDroppedPaths(paths: string[]) {
  if (paths.length === 0) return;
  const first = paths[0];
  const ext = first.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "nee") return openProject(first);
  const s = get();
  // With a video open, dropped audio files become extra tracks.
  const audioOnlyExt = ["mp3", "m4a", "aac", "ac3", "eac3", "dts", "flac", "wav", "ogg", "oga", "opus", "wma", "mka", "mp2", "thd"];
  if (s.media && hasVideoTrack(s.tracks) && paths.every((p) => audioOnlyExt.includes(p.split(".").pop()?.toLowerCase() ?? ""))) {
    if (paths.length === 1) {
      set({ dialog: { kind: "addAudio", path: first } });
    } else {
      for (const p of paths) await addExternalAudio(p);
    }
    return;
  }
  await openMedia(first);
}

export function describeKfShift(start: number): { shift: number; at: number } | null {
  const a = actualStartSync(start);
  if (a === null) return null;
  const shift = start - a;
  return shift > 0.002 ? { shift, at: a } : null;
}

export function fmt(t0: number) {
  const d = get().media?.duration ?? 0;
  return formatTime(t0, d >= 3600);
}

export { checkpoint };

// Dev-only handle for automated UI testing over CDP.
if (import.meta.env.DEV) {
  void import("./engine").then(({ engine: eng }) => {
    (window as unknown as Record<string, unknown>).__nee = {
      get, set, openMedia, openProject, addExternalAudio, markIn, markOut, engine: eng, saveProject, api,
    };
  });
}
