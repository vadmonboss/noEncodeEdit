/**
 * Preview playback.
 *
 * One <video> element (the "master") drives the clock. Audio tracks the
 * master can't play itself (other tracks of the same file, external files,
 * codecs the WebView doesn't decode) get their own <audio> elements that
 * follow the master with soft drift correction.
 */
import { get, set, useStore, wfKey } from "./store";
import { NATIVE_AUDIO_CODECS } from "./lib/media";
import type { Track } from "./lib/types";

type LoadResult = "ok" | "novideo" | "error";

interface Follower {
  el: HTMLAudioElement;
  url: string;
}

class Engine {
  master: HTMLVideoElement | null = null;
  private followers = new Map<string, Follower>();
  private raf = 0;
  private stopAt: number | null = null;
  private nativeTrackId: string | null = null;
  /** Called for audible tracks that still need a playable source. */
  requestAudio: (t: Track) => void = () => {};

  private attachWaiters: ((el: HTMLVideoElement) => void)[] = [];

  /** Resolves once the Player has mounted its <video>. */
  private whenAttached(timeoutMs = 3000): Promise<HTMLVideoElement | null> {
    if (this.master) return Promise.resolve(this.master);
    return new Promise((resolve) => {
      const timer = window.setTimeout(() => resolve(this.master), timeoutMs);
      this.attachWaiters.push((el) => {
        window.clearTimeout(timer);
        resolve(el);
      });
    });
  }

  attach(el: HTMLVideoElement) {
    if (this.master === el) return;
    this.master = el;
    const waiters = this.attachWaiters.splice(0);
    for (const w of waiters) w(el);
    el.addEventListener("play", this.onPlay);
    el.addEventListener("pause", this.onPause);
    el.addEventListener("ended", this.onPause);
    el.addEventListener("seeked", this.onSeeked);
    el.addEventListener("ratechange", () => set({ rate: el.playbackRate }));
    this.applyMasterSettings();
  }

  detach(el: HTMLVideoElement) {
    if (this.master !== el) return;
    el.removeEventListener("play", this.onPlay);
    el.removeEventListener("pause", this.onPause);
    el.removeEventListener("ended", this.onPause);
    el.removeEventListener("seeked", this.onSeeked);
    this.master = null;
  }

  /** Stops everything and forgets all sources. */
  reset() {
    this.stopAt = null;
    cancelAnimationFrame(this.raf);
    for (const f of this.followers.values()) this.dropFollower(f);
    this.followers.clear();
    const m = this.master;
    if (m) {
      m.pause();
      m.removeAttribute("src");
      m.load();
    }
    set({ playing: false, currentTime: 0 });
  }

  /** Loads a source into the master and waits until it's usable. */
  async loadMaster(url: string, expectVideo: boolean, timeoutMs = 15000): Promise<LoadResult> {
    const m = await this.whenAttached();
    if (!m) return "error";
    return new Promise<LoadResult>((resolve) => {
      let done = false;
      const finish = (r: LoadResult) => {
        if (done) return;
        done = true;
        window.clearTimeout(timer);
        m.removeEventListener("loadedmetadata", onMeta);
        m.removeEventListener("error", onError);
        resolve(r);
      };
      const onMeta = () => finish(expectVideo && !m.videoWidth ? "novideo" : "ok");
      const onError = () => finish("error");
      const timer = window.setTimeout(() => finish("error"), timeoutMs);
      m.addEventListener("loadedmetadata", onMeta);
      m.addEventListener("error", onError);
      m.preload = "auto";
      m.src = url;
      m.load();
    });
  }

  clearMaster() {
    const m = this.master;
    if (!m) return;
    m.pause();
    m.removeAttribute("src");
    m.load();
  }

  get hasSource() {
    const m = this.master;
    return !!m && !!m.currentSrc && m.readyState > 0;
  }

  // ---- transport ---------------------------------------------------------

  play(until?: number) {
    const m = this.master;
    if (!this.hasSource || !m) return;
    this.stopAt = until ?? null;
    const dur = get().media?.duration ?? m.duration;
    if (m.currentTime >= dur - 0.05) m.currentTime = 0;
    void m.play().catch(() => {});
  }

  pause() {
    this.stopAt = null;
    this.master?.pause();
  }

  toggle() {
    if (get().playing) this.pause();
    else this.play();
  }

  seek(t: number) {
    const dur = get().media?.duration ?? 0;
    const target = Math.max(0, Math.min(dur || t, t));
    set({ currentTime: target });
    const m = this.master;
    if (this.hasSource && m) {
      m.currentTime = target;
    }
    this.syncFollowers(true);
  }

  step(frames: number) {
    const s = get();
    const v = s.tracks.find((t) => t.kind === "video" && t.source === "main");
    const fps = v?.fps && v.fps > 0 ? v.fps : 25;
    this.pause();
    const k = Math.round(s.currentTime * fps) + frames;
    this.seek(Math.max(0, k / fps + 0.001));
  }

  setRate(rate: number) {
    set({ rate });
    this.applyMasterSettings();
  }

  setVolume(volume: number) {
    set({ volume, muted: false });
    this.applyMasterSettings();
  }

  toggleMute() {
    set({ muted: !get().muted });
    this.applyMasterSettings();
  }

  // ---- routing -----------------------------------------------------------

  /** The main audio track the master element plays by itself, if any. */
  private computeNative(): string | null {
    const { media, tracks, preview } = get();
    if (!media) return null;
    const audioStreams = media.streams.filter((s) => s.codec_type === "audio");
    const first = audioStreams[0];
    if (!first) return null;
    const track = tracks.find((t) => t.source === "main" && t.kind === "audio" && t.streamIndex === first.index);
    if (!track) return null;
    if (preview.mode === "audio") return track.id;
    if (preview.mode === "direct" && audioStreams.length === 1 && NATIVE_AUDIO_CODECS.has(track.codec)) {
      return track.id;
    }
    return null;
  }

  isNative(trackId: string) {
    return this.nativeTrackId === trackId;
  }

  private applyMasterSettings() {
    const m = this.master;
    const s = get();
    if (!m) return;
    const native = s.tracks.find((t) => t.id === this.nativeTrackId);
    m.volume = s.volume;
    m.muted = s.muted || !native || !native.audible;
    if (m.playbackRate !== s.rate) m.playbackRate = s.rate;
  }

  /** Re-evaluates which elements play which tracks. */
  updateRouting() {
    const s = get();
    this.nativeTrackId = this.computeNative();
    this.applyMasterSettings();

    const want = new Map<string, string>();
    // Until the master source is settled we don't know which track it plays itself.
    const settled = s.preview.status === "ready" || s.preview.status === "error";
    for (const t of settled ? s.tracks : []) {
      if (t.kind !== "audio" || !t.audible || t.id === this.nativeTrackId) continue;
      const prep = s.audioPrep[wfKey(t.filePath, t.streamIndex)];
      if (prep?.status === "ready" && prep.url) want.set(t.id, prep.url);
      else if (!prep || prep.status === "idle") this.requestAudio(t);
    }
    for (const [id, f] of this.followers) {
      if (want.get(id) !== f.url) {
        this.dropFollower(f);
        this.followers.delete(id);
      }
    }
    for (const [id, url] of want) {
      if (this.followers.has(id)) continue;
      const el = new Audio();
      el.preload = "auto";
      el.src = url;
      this.followers.set(id, { el, url });
    }
    this.syncFollowers(true);
  }

  private dropFollower(f: Follower) {
    f.el.pause();
    f.el.removeAttribute("src");
    f.el.load();
  }

  private syncFollowers(force = false) {
    const m = this.master;
    const s = get();
    const playing = !!m && !m.paused && !m.ended;
    const now = m && this.hasSource ? m.currentTime : s.currentTime;
    for (const [id, f] of this.followers) {
      const t = s.tracks.find((x) => x.id === id);
      if (!t) continue;
      const el = f.el;
      el.volume = s.volume;
      el.muted = s.muted;
      const target = now - (t.source === "external" ? t.offset : 0);
      const dur = isFinite(el.duration) ? el.duration : Infinity;
      if (target < 0 || target >= dur) {
        if (!el.paused) el.pause();
        if (target < 0 && el.currentTime !== 0) el.currentTime = 0;
        continue;
      }
      if (playing) {
        if (el.paused) {
          el.currentTime = target;
          el.playbackRate = s.rate;
          void el.play().catch(() => {});
          continue;
        }
        const diff = target - el.currentTime;
        if (Math.abs(diff) > 0.25) {
          el.currentTime = target;
          el.playbackRate = s.rate;
        } else if (Math.abs(diff) > 0.03) {
          el.playbackRate = s.rate * (diff > 0 ? 1.04 : 0.96);
        } else if (el.playbackRate !== s.rate) {
          el.playbackRate = s.rate;
        }
      } else {
        if (!el.paused) el.pause();
        if (force || Math.abs(el.currentTime - target) > 0.04) el.currentTime = target;
      }
    }
  }

  // ---- clock -------------------------------------------------------------

  private onPlay = () => {
    set({ playing: true });
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(this.tick);
  };

  private onPause = () => {
    set({ playing: false });
    cancelAnimationFrame(this.raf);
    const m = this.master;
    if (m) set({ currentTime: m.currentTime });
    this.syncFollowers(true);
  };

  private onSeeked = () => {
    const m = this.master;
    if (m && !get().playing) set({ currentTime: m.currentTime });
    this.syncFollowers(true);
  };

  private tick = () => {
    const m = this.master;
    if (!m) return;
    let t = m.currentTime;
    if (this.stopAt !== null && t >= this.stopAt) {
      t = this.stopAt;
      this.stopAt = null;
      m.pause();
      m.currentTime = t;
    }
    if (t !== get().currentTime) set({ currentTime: t });
    this.syncFollowers();
    if (!m.paused) this.raf = requestAnimationFrame(this.tick);
  };
}

export const engine = new Engine();

// Keep elements in sync with monitoring-related state.
useStore.subscribe((s, prev) => {
  if (s.tracks !== prev.tracks || s.audioPrep !== prev.audioPrep || s.preview !== prev.preview) {
    engine.updateRouting();
  } else if (s.volume !== prev.volume || s.muted !== prev.muted || s.rate !== prev.rate) {
    engine.updateRouting();
  }
});
