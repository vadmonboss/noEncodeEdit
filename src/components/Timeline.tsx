import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Captions,
  Film,
  HeadphoneOff,
  Headphones,
  Loader2,
  Magnet,
  Maximize2,
  MoreVertical,
  Plus,
  Star,
  ZoomIn,
  ZoomOut,
  AudioLines,
  FileAudio,
  ArrowUp,
  ArrowDown,
  Trash2,
  Replace,
  Tags,
} from "lucide-react";
import { checkpoint, get, set, sortedFragments, updateTrack, useStore, wfKey } from "../store";
import { useT } from "../i18n";
import {
  actualStartSync,
  clampView,
  fitView,
  fmt,
  moveTrack,
  pickExternalAudio,
  removeTrack,
  selectFragment,
  snapToKeyframe,
  updateFragment,
  zoomAt,
} from "../controller";
import { engine } from "../engine";
import { lastAtOrBefore, nearest } from "../lib/keyframes";
import { formatTime } from "../lib/time";
import { resolveContainer, staticCompatible, trackLabel } from "../lib/media";
import type { Fragment, Track, Waveform } from "../lib/types";
import { MenuButton, Switch } from "./ui";

const HEAD_W = 300;

// ---------------------------------------------------------------------------
// Theme colors for canvases
// ---------------------------------------------------------------------------

interface Colors {
  wave: string;
  waveOff: string;
  kf: string;
  rulerText: string;
  border: string;
  text3: string;
}

function useColors(): Colors {
  const theme = useStore((s) => s.theme);
  return useMemo(() => {
    const cs = getComputedStyle(document.documentElement);
    const v = (n: string) => cs.getPropertyValue(n).trim();
    return {
      wave: v("--wave"),
      waveOff: v("--wave-off"),
      kf: v("--kf"),
      rulerText: v("--ruler-text"),
      border: v("--border-strong"),
      text3: v("--text-3"),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme]);
}

function setupCanvas(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return ctx;
}

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

export default function Timeline() {
  const tr = useT();
  const lanesRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const media = useStore((s) => s.media)!;
  const tracks = useStore((s) => s.tracks);
  const view = useStore((s) => s.view);
  const width = useStore((s) => s.timelineWidth);
  const keyframes = useStore((s) => s.keyframes);
  const [hover, setHover] = useState<number | null>(null);
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null);

  // Track width of the lanes column.
  useLayoutEffect(() => {
    const el = lanesRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth;
      const s = get();
      const d = s.media?.duration ?? 0;
      const wasFit = s.view.pps === 0 || (d > 0 && Math.abs(s.view.pps - s.timelineWidth / d) < 1e-6 && s.view.start === 0);
      set({ timelineWidth: w });
      if (wasFit) fitView();
      else set({ view: clampView(s.view.start, s.view.pps) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const timeAt = useCallback((clientX: number) => {
    const el = lanesRef.current!;
    const r = el.getBoundingClientRect();
    const s = get();
    return Math.max(0, Math.min(s.media?.duration ?? 0, s.view.start + (clientX - r.left) / s.view.pps));
  }, []);

  // Auto-follow the playhead while playing.
  useEffect(
    () =>
      useStore.subscribe((s, prev) => {
        if (!s.playing || s.currentTime === prev.currentTime || !s.view.pps) return;
        const x = (s.currentTime - s.view.start) * s.view.pps;
        if (x > s.timelineWidth - 24 || x < 0) {
          set({ view: clampView(s.currentTime - (s.timelineWidth * 0.08) / s.view.pps, s.view.pps) });
        }
      }),
    [],
  );

  // Scrub (click / drag on empty lane area or ruler).
  const onLanesPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest(".handle, .flag, .lane-bar.ext, .body")) return;
    e.preventDefault();
    const el = lanesRef.current!;
    el.setPointerCapture(e.pointerId);
    const wasPlaying = get().playing;
    if (wasPlaying) engine.pause();
    engine.seek(timeAt(e.clientX));
    const move = (ev: PointerEvent) => engine.seek(timeAt(ev.clientX));
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };

  const onWheel = (e: React.WheelEvent) => {
    const s = get();
    if (e.ctrlKey) {
      zoomAt(e.deltaY < 0 ? 1.25 : 0.8, timeAt(e.clientX));
      return;
    }
    const body = bodyRef.current;
    const canScrollY = body && body.scrollHeight > body.clientHeight + 2;
    const dx = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.shiftKey || !canScrollY ? e.deltaY : 0;
    if (dx !== 0) set({ view: clampView(s.view.start + dx / s.view.pps, s.view.pps) });
  };

  // Native non-passive listener so Ctrl+wheel doesn't zoom the page.
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const stop = (e: WheelEvent) => {
      if (e.ctrlKey) e.preventDefault();
    };
    el.addEventListener("wheel", stop, { passive: false });
    return () => el.removeEventListener("wheel", stop);
  }, []);

  const exportSettings = useStore((s) => s.exportSettings);
  const hasVideoOut = tracks.some((x) => x.kind === "video" && x.enabled);
  const container = resolveContainer(exportSettings.container, media, hasVideoOut);
  const firstEnabledAudio = tracks.find((x) => x.kind === "audio" && x.enabled)?.id;
  const audioNums = new Map<string, number>();
  let an = 0;
  let sn = 0;
  for (const x of tracks) {
    if (x.source !== "main") continue;
    if (x.kind === "audio") audioNums.set(x.id, ++an);
    if (x.kind === "subtitle") audioNums.set(x.id, ++sn);
  }
  const hasVideo = tracks.some((x) => x.kind === "video" && x.source === "main");

  return (
    <section className="card timeline">
      <div className="tl-head">
        <span className="card-title">{tr("tracks.title")}</span>
        {hasVideo && (
          <span className="badge" title={tr("tl.snapOn")}>
            <Magnet size={12} />
            {keyframes.status === "loading"
              ? tr("tracks.scanning", { p: Math.round(keyframes.progress * 100) })
              : keyframes.status === "ready"
                ? tr("tracks.keyframes", { n: keyframes.times.length })
                : "Alt"}
          </span>
        )}
        <div className="spacer" />
        <span className="mono faint" style={{ fontSize: 12, minWidth: 96, textAlign: "right" }}>
          {hover !== null ? fmt(hover) : ""}
        </span>
        <button className="icon-btn sm" title={tr("tl.zoomOut")} onClick={() => zoomAt(1 / 1.6)}>
          <ZoomOut size={16} />
        </button>
        <button className="icon-btn sm" title={tr("tl.zoomIn")} onClick={() => zoomAt(1.6)}>
          <ZoomIn size={16} />
        </button>
        <button className="icon-btn sm" title={tr("tl.fit")} onClick={fitView}>
          <Maximize2 size={15} />
        </button>
      </div>

      <div className="tl-body" ref={bodyRef} onWheel={onWheel} style={{ overflowY: "auto", display: "block" }}>
        <div style={{ display: "grid", gridTemplateColumns: `${HEAD_W}px minmax(0, 1fr)` }}>
          <div className="tl-heads">
            <div className="tl-ruler-head">{formatTime(view.start, media.duration >= 3600, 1)}</div>
            {tracks.map((x) => (
              <TrackHead
                key={x.id}
                track={x}
                num={audioNums.get(x.id) ?? 0}
                replacedNum={x.replacesId ? audioNums.get(x.replacesId) : undefined}
                isDefault={x.id === firstEnabledAudio}
                incompatible={x.enabled && staticCompatible(container.muxer, x) === false ? container.label : null}
              />
            ))}
            <div className="add-track">
              <button className="btn btn-accent-soft btn-sm" onClick={() => void pickExternalAudio()}>
                <Plus size={15} />
                {tr("tracks.add")}
              </button>
            </div>
          </div>

          <div
            className="tl-lanes"
            ref={lanesRef}
            onPointerDown={onLanesPointerDown}
            onPointerMove={(e) => setHover(timeAt(e.clientX))}
            onPointerLeave={() => setHover(null)}
          >
            <Ruler view={view} width={width} duration={media.duration} />
            {tracks.map((x) => (
              <Lane key={x.id} track={x} view={view} width={width} duration={media.duration} setTip={setTip} />
            ))}
            <div className="lane add-track-lane" />
            <FragmentOverlays view={view} width={width} timeAt={timeAt} setTip={setTip} />
            <Playhead view={view} />
          </div>
        </div>
      </div>
      <Minimap />
      {tip && (
        <div className="drag-tip mono" style={{ left: tip.x, top: tip.y }}>
          {tip.text}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Ruler
// ---------------------------------------------------------------------------

const STEPS = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200];

const Ruler = memo(function Ruler({ view, width, duration }: { view: { start: number; pps: number }; width: number; duration: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const colors = useColors();
  useEffect(() => {
    const c = ref.current;
    if (!c || !view.pps) return;
    const ctx = setupCanvas(c);
    if (!ctx) return;
    const w = c.clientWidth;
    const h = c.clientHeight;
    const major = STEPS.find((s) => s * view.pps >= 92) ?? 7200;
    const sub = major >= 60 && major % 60 === 0 ? 6 : major === 15 ? 3 : 5;
    const minor = major / sub;
    const end = Math.min(duration, view.start + w / view.pps);
    ctx.font = '10.5px "JetBrains Mono Variable", Consolas, monospace';
    ctx.textBaseline = "top";
    const first = Math.floor(view.start / minor) * minor;
    const long = duration >= 3600;
    const digits = major < 0.1 ? 2 : major < 1 ? 1 : 0;
    for (let i = 0; ; i++) {
      const t = first + i * minor;
      if (t > end + minor) break;
      const x = Math.round((t - view.start) * view.pps) + 0.5;
      if (x < -50 || x > w + 50) continue;
      const isMajor = Math.abs(t / major - Math.round(t / major)) < 1e-6;
      ctx.strokeStyle = colors.border;
      ctx.beginPath();
      ctx.moveTo(x, h);
      ctx.lineTo(x, h - (isMajor ? 10 : 5));
      ctx.stroke();
      if (isMajor && t <= duration + 1e-6) {
        ctx.fillStyle = colors.rulerText;
        ctx.fillText(formatTime(t, long, digits), x + 4, 5);
      }
    }
    // End of media marker.
    const xe = (duration - view.start) * view.pps;
    if (xe >= 0 && xe <= w) {
      ctx.fillStyle = colors.border;
      ctx.fillRect(xe, 0, 1, h);
    }
  }, [view, width, duration, colors]);
  return (
    <div className="tl-ruler">
      <canvas ref={ref} />
    </div>
  );
});

// ---------------------------------------------------------------------------
// Lanes
// ---------------------------------------------------------------------------

interface LaneProps {
  track: Track;
  view: { start: number; pps: number };
  width: number;
  duration: number;
  setTip: (t: { x: number; y: number; text: string } | null) => void;
}

const Lane = memo(function Lane({ track, view, width, duration, setTip }: LaneProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  const colors = useColors();
  const wave = useStore((s) => (track.kind === "audio" ? s.waveforms[wfKey(track.filePath, track.streamIndex)] : undefined));
  const keyframes = useStore((s) => (track.kind === "video" && track.source === "main" ? s.keyframes : null));

  useEffect(() => {
    const c = ref.current;
    if (!c || !view.pps) return;
    const ctx = setupCanvas(c);
    if (!ctx) return;
    const w = c.clientWidth;
    const h = c.clientHeight;
    if (track.kind === "audio" && wave) drawWave(ctx, w, h, view, track, wave, track.enabled ? colors.wave : colors.waveOff);
    if (keyframes) {
      const times = keyframes.status === "ready" ? keyframes.times : keyframes.partial;
      drawKeyframes(ctx, w, h, view, times, colors.kf);
    }
  }, [view, width, wave, wave?.length, keyframes, track, colors]);

  const off = track.source === "external" ? track.offset : 0;
  const barStart = (track.source === "external" ? off : track.startTime) - view.start;
  const barLen = track.source === "external" ? track.duration : Math.min(track.duration, duration - track.startTime);
  const left = barStart * view.pps;
  const barW = Math.max(2, barLen * view.pps);

  const onBarDown = (e: React.PointerEvent) => {
    if (track.source !== "external" || e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const x0 = e.clientX;
    const startOffset = track.offset;
    let moved = false;
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - x0;
      if (!moved && Math.abs(dx) < 3) return;
      if (!moved) {
        checkpoint();
        moved = true;
      }
      const pps = get().view.pps;
      const next = Math.round((startOffset + dx / pps) * 1000) / 1000;
      updateTrack(track.id, { offset: next }, false);
      setTip({ x: ev.clientX, y: ev.clientY, text: `${next >= 0 ? "+" : ""}${Math.round(next * 1000)} ms` });
    };
    const up = (ev: PointerEvent) => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      setTip(null);
      if (!moved) {
        // A plain click seeks like elsewhere on the lane.
        const lanes = el.closest(".tl-lanes") as HTMLElement;
        const r = lanes.getBoundingClientRect();
        const s = get();
        engine.seek(s.view.start + (ev.clientX - r.left) / s.view.pps);
      }
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };

  return (
    <div className={`lane ${track.kind} ${track.enabled ? "" : "disabled"}`}>
      <div
        className={`lane-bar ${track.kind} ${track.source === "external" ? "ext" : ""}`}
        style={{ left, width: barW }}
        onPointerDown={onBarDown}
      />
      <canvas ref={ref} />
    </div>
  );
});

function drawWave(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  view: { start: number; pps: number },
  track: Track,
  wave: Waveform,
  color: string,
) {
  if (!wave.pps || wave.length === 0) return;
  const off = track.source === "external" ? track.offset : 0;
  const mid = h / 2;
  const maxH = h - 12;
  ctx.fillStyle = color;
  const peaks = wave.peaks;
  const len = wave.length;
  const pps = wave.pps;
  for (let x = 0; x < w; x++) {
    const t0 = view.start + x / view.pps - off;
    const t1 = t0 + 1 / view.pps;
    if (t1 < 0) continue;
    let i0 = Math.floor(t0 * pps);
    let i1 = Math.floor(t1 * pps);
    if (i0 >= len) break;
    if (i0 < 0) i0 = 0;
    if (i1 <= i0) i1 = i0 + 1;
    if (i1 > len) i1 = len;
    let m = 0;
    for (let i = i0; i < i1; i++) if (peaks[i] > m) m = peaks[i];
    const a = Math.pow(m / 255, 0.75);
    const bh = Math.max(1, a * maxH);
    ctx.fillRect(x, mid - bh / 2, 1, bh);
  }
}

function drawKeyframes(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  view: { start: number; pps: number },
  times: ArrayLike<number>,
  color: string,
) {
  if (times.length === 0) return;
  const tEnd = view.start + w / view.pps;
  let i = Math.max(0, lastAtOrBefore(times, view.start));
  ctx.fillStyle = color;
  let lastX = -10;
  const tall = view.pps > 30;
  for (; i < times.length; i++) {
    const t = times[i];
    if (t > tEnd) break;
    const x = Math.round((t - view.start) * view.pps);
    if (x - lastX < 2) continue;
    lastX = x;
    if (tall) {
      ctx.fillRect(x, 4, 1.5, h - 8);
      ctx.beginPath();
      ctx.moveTo(x - 3.5, h - 4);
      ctx.lineTo(x + 5, h - 4);
      ctx.lineTo(x + 0.75, h - 10);
      ctx.fill();
    } else {
      ctx.fillRect(x, h - 14, 1, 10);
    }
  }
}

// ---------------------------------------------------------------------------
// Track heads
// ---------------------------------------------------------------------------

function TrackHead({
  track,
  num,
  replacedNum,
  isDefault,
  incompatible,
}: {
  track: Track;
  num: number;
  replacedNum?: number;
  isDefault: boolean;
  incompatible: string | null;
}) {
  const tr = useT();
  const prep = useStore((s) => s.audioPrep[wfKey(track.filePath, track.streamIndex)]);
  const [offsetText, setOffsetText] = useState<string | null>(null);
  const external = track.source === "external";

  const icon =
    track.kind === "video" ? (
      <Film size={15} />
    ) : track.kind === "audio" ? (
      external ? <FileAudio size={15} /> : <AudioLines size={15} />
    ) : (
      <Captions size={15} />
    );
  const nameTitle = external
    ? `${tr("tracks.external")}: ${track.filePath}${replacedNum ? `
${tr("tracks.replaces", { name: `${tr("tracks.audio")} ${replacedNum}` })}` : ""}`
    : track.codecLong;
  // Recorders like OBS name their tracks ("Game", "Mic"…): show that first.
  const generic =
    track.kind === "video"
      ? tr("tracks.video")
      : track.source === "external"
        ? track.fileName
        : `${track.kind === "audio" ? tr("tracks.audio") : tr("tracks.subtitle")} ${num}`;
  const name = track.title || generic;

  const meta = [track.title && track.kind !== "video" ? generic : null, trackLabel(track)].filter(Boolean).join(" · ");

  const menuItems = [
    {
      label: tr("tracks.meta"),
      icon: <Tags size={16} />,
      onClick: () => set({ dialog: { kind: "trackMeta", trackId: track.id } }),
    },
    ...(track.kind !== "video"
      ? [
          { label: tr("tracks.moveUp"), icon: <ArrowUp size={16} />, onClick: () => moveTrack(track.id, -1) },
          { label: tr("tracks.moveDown"), icon: <ArrowDown size={16} />, onClick: () => moveTrack(track.id, 1) },
        ]
      : []),
    ...(track.kind === "audio" && track.source === "main"
      ? [
          "sep" as const,
          { label: tr("tracks.replaceWith"), icon: <Replace size={16} />, onClick: () => void pickExternalAudio(track.id) },
        ]
      : []),
    ...(track.source === "external"
      ? [
          "sep" as const,
          { label: tr("tracks.remove"), icon: <Trash2 size={16} />, danger: true, onClick: () => removeTrack(track.id) },
        ]
      : []),
  ];

  const isNative = engine.isNative(track.id);
  const preparing = track.audible && !isNative && prep?.status === "preparing";
  const prepError = track.audible && !isNative && prep?.status === "error";

  return (
    <div className={`track-head ${track.kind} ${track.enabled ? "" : "off"}`}>
      <Switch
        on={track.enabled}
        title={track.enabled ? tr("tracks.exclude") : tr("tracks.include")}
        onChange={(v) => updateTrack(track.id, { enabled: v })}
      />
      <div className={`ic ${external ? "ext" : ""}`} title={external ? tr("tracks.external") : undefined}>
        {icon}
      </div>
      <div className="info">
        <div className="t1" title={nameTitle}>
          <span className="nm">{name}</span>
          {track.language && <span className="tag gray">{track.language}</span>}
          {track.kind === "audio" && isDefault && (
            <span title={tr("tracks.defaultTitle")} style={{ display: "inline-flex" }}>
              <Star size={12} fill="var(--warn)" color="var(--warn)" />
            </span>
          )}
          {incompatible && (
            <span className="tag warn" title={tr("tracks.incompatible", { fmt: incompatible })}>
              <AlertTriangle size={10} style={{ verticalAlign: -1 }} /> {incompatible}
            </span>
          )}
        </div>
        <div className="t2">
          {track.kind === "audio" && preparing ? (
            <span>{tr("tracks.preparingAudio", { p: Math.round((prep?.progress ?? 0) * 100) })}</span>
          ) : (
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }} title={meta}>
              {replacedNum ? `⇄ ${tr("tracks.audio")} ${replacedNum} · ` : ""}
              {meta}
            </span>
          )}
          {external && (
            <span className="offset-wrap" title={tr("tracks.offsetTitle")}>
            <input
              className="offset-input mono"
              title={tr("tracks.offsetTitle")}
              value={offsetText ?? String(Math.round(track.offset * 1000))}
              onFocus={(e) => {
                setOffsetText(String(Math.round(track.offset * 1000)));
                e.target.select();
              }}
              onChange={(e) => setOffsetText(e.target.value.replace(/[^\d-+]/g, ""))}
              onBlur={() => {
                const v = parseInt(offsetText ?? "", 10);
                if (isFinite(v) && v / 1000 !== track.offset) updateTrack(track.id, { offset: v / 1000 });
                setOffsetText(null);
              }}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                if (e.key === "Escape") {
                  setOffsetText(null);
                  (e.target as HTMLInputElement).blur();
                }
                if (e.key === "ArrowUp" || e.key === "ArrowDown") {
                  e.preventDefault();
                  const step = e.shiftKey ? 100 : 10;
                  const cur = parseInt(offsetText ?? "0", 10) || 0;
                  setOffsetText(String(cur + (e.key === "ArrowUp" ? step : -step)));
                }
              }}
            />
            {tr("fmt.ms")}
            </span>
          )}
        </div>
      </div>
      {track.kind === "audio" && (
        <button
          className={`icon-btn sm ${track.audible ? "active" : ""}`}
          title={prepError ? `${tr("tracks.audioError")}: ${prep?.error ?? ""}` : track.audible ? tr("tracks.mute") : tr("tracks.listen")}
          onClick={() => {
            if (prepError) {
              set({ audioPrep: { ...get().audioPrep, [wfKey(track.filePath, track.streamIndex)]: { status: "idle", progress: 0 } } });
            }
            updateTrack(track.id, { audible: !track.audible }, false);
          }}
        >
          {preparing ? (
            <Loader2 size={15} className="spin" />
          ) : prepError ? (
            <AlertTriangle size={15} color="var(--warn)" />
          ) : track.audible ? (
            <Headphones size={15} />
          ) : (
            <HeadphoneOff size={15} />
          )}
        </button>
      )}
      <MenuButton
        items={menuItems}
        align="left"
        button={(_, toggle) => (
          <button className="icon-btn sm" title={tr("tracks.menu")} onClick={toggle}>
            <MoreVertical size={15} />
          </button>
        )}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Fragment overlays & playhead
// ---------------------------------------------------------------------------

function FragmentOverlays({
  view,
  width,
  timeAt,
  setTip,
}: {
  view: { start: number; pps: number };
  width: number;
  timeAt: (clientX: number) => number;
  setTip: (t: { x: number; y: number; text: string } | null) => void;
}) {
  const fragments = useStore((s) => s.fragments);
  const activeId = useStore((s) => s.activeId);
  const keyframes = useStore((s) => s.keyframes);
  const hasDraft = fragments.some((f) => f.end === null);
  const currentTime = useStore((s) => (hasDraft ? s.currentTime : 0));
  const list = sortedFragments(fragments);
  const tEnd = view.start + width / view.pps;

  return (
    <>
      {list.map((f, i) => {
        const end = f.end ?? Math.max(f.start, currentTime);
        if (end < view.start || f.start > tEnd) return null;
        const actual = actualStartSync(f.start);
        const shifted = actual !== null && f.start - actual > 0.002;
        return (
          <FragmentOverlay
            key={f.id}
            f={f}
            n={i + 1}
            end={end}
            active={f.id === activeId}
            view={view}
            shifted={shifted}
            actual={actual}
            timeAt={timeAt}
            setTip={setTip}
            kfReady={keyframes.status === "ready"}
          />
        );
      })}
    </>
  );
}

function FragmentOverlay({
  f,
  n,
  end,
  active,
  view,
  shifted,
  actual,
  timeAt,
  setTip,
  kfReady,
}: {
  f: Fragment;
  n: number;
  end: number;
  active: boolean;
  view: { start: number; pps: number };
  shifted: boolean;
  actual: number | null;
  timeAt: (clientX: number) => number;
  setTip: (t: { x: number; y: number; text: string } | null) => void;
  kfReady: boolean;
}) {
  const tr = useT();
  const left = (f.start - view.start) * view.pps;
  const w = Math.max(2, (end - f.start) * view.pps);
  const draft = f.end === null;

  const startDrag = (edge: "start" | "end") => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    checkpoint();
    set({ activeId: f.id });
    engine.pause();
    const hasVideo = get().tracks.some((x) => x.kind === "video" && x.source === "main");
    let last = edge === "start" ? f.start : (f.end ?? f.start);
    let alt = e.altKey;
    const move = (ev: PointerEvent) => {
      alt = ev.altKey;
      let t = timeAt(ev.clientX);
      const cur = get().fragments.find((x) => x.id === f.id);
      if (!cur) return;
      if (edge === "start") {
        const s = get();
        if (hasVideo && !alt && s.keyframes.status === "ready") t = nearest(s.keyframes.times, t) ?? t;
        if (cur.end !== null) t = Math.min(t, cur.end - 0.04);
        t = Math.max(0, t);
      } else {
        t = Math.max(cur.start + 0.04, Math.min(get().media?.duration ?? t, t));
      }
      if (t === last) return;
      last = t;
      updateFragment(f.id, edge === "start" ? { start: t } : { end: t }, false);
      engine.seek(t);
      setTip({ x: ev.clientX, y: ev.clientY, text: fmt(t) + (edge === "start" && alt && hasVideo ? "  Alt" : "") });
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      setTip(null);
      if (edge === "start" && hasVideo && !alt && !kfReady) {
        void snapToKeyframe(last).then((k) => {
          if (k !== last) {
            updateFragment(f.id, { start: k }, false);
            engine.seek(k);
          }
        });
      }
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };

  return (
    <>
      {shifted && actual !== null && (
        <div className="kf-ghost" style={{ left: (actual - view.start) * view.pps }} />
      )}
      <div
        className={`frag-overlay ${active ? "active" : "inactive"} ${draft ? "draft" : ""}`}
        style={{ left, width: w }}
      >
        <div
          className="body"
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.stopPropagation();
            selectFragment(f.id);
            engine.seek(timeAt(e.clientX));
          }}
          onDoubleClick={() => selectFragment(f.id, "start")}
        />
        <div className="handle in" onPointerDown={startDrag("start")} />
        <div
          className={`flag in ${shifted ? "warn" : ""}`}
          onPointerDown={startDrag("start")}
          title={shifted && actual !== null ? tr("frag.kfWarn", { d: `${(f.start - actual).toFixed(2)} s`, t: fmt(actual) }) : undefined}
        >
          {shifted && <AlertTriangle size={11} />}[{n}
        </div>
        {!draft && (
          <>
            <div className="handle out" onPointerDown={startDrag("end")} />
            {w > 46 && (
              <div className="flag out" onPointerDown={startDrag("end")}>
                {n}]
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}

function Playhead({ view }: { view: { start: number; pps: number } }) {
  const t = useStore((s) => s.currentTime);
  const x = (t - view.start) * view.pps;
  if (x < -2) return null;
  return <div className="playhead" style={{ left: x }} />;
}

// ---------------------------------------------------------------------------
// Minimap
// ---------------------------------------------------------------------------

function Minimap() {
  const ref = useRef<HTMLDivElement>(null);
  const media = useStore((s) => s.media)!;
  const view = useStore((s) => s.view);
  const width = useStore((s) => s.timelineWidth);
  const fragments = useStore((s) => s.fragments);
  const t = useStore((s) => s.currentTime);
  const d = media.duration || 1;
  const visible = view.pps ? width / view.pps : d;
  const fit = visible >= d - 1e-6;

  const onDown = (e: React.PointerEvent) => {
    const el = ref.current!;
    const r = el.getBoundingClientRect();
    const toTime = (cx: number) => ((cx - r.left) / r.width) * d;
    const isWin = (e.target as HTMLElement).classList.contains("win");
    const s0 = get().view.start;
    const t0 = toTime(e.clientX);
    if (!isWin) set({ view: clampView(t0 - visible / 2, get().view.pps) });
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const dt = toTime(ev.clientX) - t0;
      set({ view: clampView((isWin ? s0 : t0 - visible / 2) + dt, get().view.pps) });
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };

  return (
    <div className="minimap" ref={ref} onPointerDown={onDown} style={{ opacity: fit ? 0.6 : 1 }}>
      {fragments.map((f) =>
        f.end === null ? null : (
          <div
            key={f.id}
            className="mm-frag"
            style={{ left: `${(f.start / d) * 100}%`, width: `${Math.max(0.3, ((f.end - f.start) / d) * 100)}%` }}
          />
        ),
      )}
      {!fit && (
        <div className="win" style={{ left: `${(view.start / d) * 100}%`, width: `${(visible / d) * 100}%` }} />
      )}
      <div className="mm-head" style={{ left: `${(t / d) * 100}%` }} />
    </div>
  );
}
