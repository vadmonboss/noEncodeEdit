import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  ChevronFirst,
  ChevronLast,
  ChevronsLeft,
  ChevronsRight,
  KeyRound,
  Loader2,
  Music2,
  Pause,
  Play,
  StepBack,
  StepForward,
  Volume2,
  VolumeX,
} from "lucide-react";
import { engine } from "../engine";
import { hasVideoTrack, useStore } from "../store";
import { useT } from "../i18n";
import { jumpBoundary, jumpKeyframe, knownKeyframes, markIn, markOut } from "../controller";
import { formatTime, parseTime } from "../lib/time";
import { isOnKeyframe } from "../lib/keyframes";
import { Progress } from "./ui";

export default function Player() {
  const tr = useT();
  const ref = useRef<HTMLVideoElement>(null);
  const media = useStore((s) => s.media)!;
  const tracks = useStore((s) => s.tracks);
  const preview = useStore((s) => s.preview);
  const playing = useStore((s) => s.playing);
  const keyframes = useStore((s) => s.keyframes);
  const currentTime = useStore((s) => s.currentTime);
  const isVideo = hasVideoTrack(tracks);

  useEffect(() => {
    const el = ref.current!;
    engine.attach(el);
    return () => engine.detach(el);
  }, []);

  const onKf = isVideo && keyframes.status !== "none" && isOnKeyframe(knownKeyframes(), currentTime);
  const proxy = preview.mode === "remux" || preview.mode === "transcode";

  return (
    <section className="card player">
      <div className="screen">
        <video ref={ref} playsInline onClick={() => engine.toggle()} style={{ opacity: isVideo ? 1 : 0 }} />
        {!isVideo && (
          <div className="audio-art">
            <div className="disc">
              <Music2 size={52} />
            </div>
            <div style={{ fontWeight: 700 }}>{media.name}</div>
            <div style={{ fontSize: 12.5, opacity: 0.7 }}>{tr("player.audioOnly")}</div>
          </div>
        )}
        <div className="screen-badges">
          {proxy && preview.status === "ready" && <span className="badge">{tr("player.proxyBadge")}</span>}
          {onKf && (
            <span className="badge kf">
              <KeyRound size={12} />
              {tr("player.onKeyframe")}
            </span>
          )}
        </div>
        {preview.status === "loading" && (
          <div className="overlay" style={{ background: "transparent", backdropFilter: "none" }}>
            <Loader2 className="spin" size={28} />
          </div>
        )}
        {preview.status === "preparing" && (
          <div className="overlay">
            <Loader2 className="spin" size={30} />
            <b>{tr("player.preparing")}</b>
            <Progress value={preview.progress} />
            <span className="mono" style={{ fontSize: 12 }}>
              {Math.round(preview.progress * 100)}%
            </span>
            <p>{tr("player.preparingNote")}</p>
          </div>
        )}
        {preview.status === "error" && (
          <div className="overlay">
            <AlertTriangle size={30} color="var(--warn)" />
            <p style={{ color: "#e9e7ff" }}>{preview.error ?? tr("player.previewFailed")}</p>
          </div>
        )}
      </div>
      <Transport playing={playing} />
    </section>
  );
}

function Transport({ playing }: { playing: boolean }) {
  const tr = useT();
  const media = useStore((s) => s.media)!;
  const tracks = useStore((s) => s.tracks);
  const rate = useStore((s) => s.rate);
  const volume = useStore((s) => s.volume);
  const muted = useStore((s) => s.muted);
  const isVideo = hasVideoTrack(tracks);

  return (
    <div className="transport">
      <button className="icon-btn" title={tr("player.prevBoundary")} onClick={() => jumpBoundary(-1)}>
        <ChevronFirst size={19} />
      </button>
      {isVideo && (
        <button className="icon-btn" title={tr("player.prevKey")} onClick={() => void jumpKeyframe(-1)}>
          <ChevronsLeft size={19} />
        </button>
      )}
      <button className="icon-btn" title={tr("player.prevFrame")} onClick={() => engine.step(-1)}>
        <StepBack size={18} />
      </button>
      <button
        className="icon-btn play"
        title={playing ? tr("player.pause") : tr("player.play")}
        onClick={() => engine.toggle()}
      >
        {playing ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" style={{ marginLeft: 2 }} />}
      </button>
      <button className="icon-btn" title={tr("player.nextFrame")} onClick={() => engine.step(1)}>
        <StepForward size={18} />
      </button>
      {isVideo && (
        <button className="icon-btn" title={tr("player.nextKey")} onClick={() => void jumpKeyframe(1)}>
          <ChevronsRight size={19} />
        </button>
      )}
      <button className="icon-btn" title={tr("player.nextBoundary")} onClick={() => jumpBoundary(1)}>
        <ChevronLast size={19} />
      </button>

      <TimeCode duration={media.duration} />

      <div className="spacer" />

      <button
        className="mark-btn"
        title={tr("player.markInTitle")}
        onClick={(e) => void markIn(e.altKey)}
      >
        <kbd>I</kbd>
        {tr("player.markIn")}
      </button>
      <button className="mark-btn" title={tr("player.markOutTitle")} onClick={() => markOut()}>
        <kbd>O</kbd>
        {tr("player.markOut")}
      </button>

      <select
        className="rate-select"
        title={tr("player.speed")}
        value={rate}
        onChange={(e) => engine.setRate(parseFloat(e.target.value))}
      >
        {[0.25, 0.5, 1, 1.5, 2, 4].map((r) => (
          <option key={r} value={r}>
            {r}×
          </option>
        ))}
      </select>
      <div className="vol" title={tr("player.volume")}>
        <button className="icon-btn sm" onClick={() => engine.toggleMute()}>
          {muted || volume === 0 ? <VolumeX size={17} /> : <Volume2 size={17} />}
        </button>
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={muted ? 0 : volume}
          onChange={(e) => engine.setVolume(parseFloat(e.target.value))}
        />
      </div>
    </div>
  );
}

function TimeCode({ duration }: { duration: number }) {
  const tr = useT();
  const t = useStore((s) => s.currentTime);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const long = duration >= 3600;

  if (editing) {
    return (
      <div className="timecode mono">
        <input
          autoFocus
          value={text}
          placeholder={tr("player.goto")}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => setEditing(false)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") {
              const v = parseTime(text);
              if (v !== null) engine.seek(v);
              setEditing(false);
            } else if (e.key === "Escape") setEditing(false);
          }}
        />
        <span className="total">/ {formatTime(duration, long)}</span>
      </div>
    );
  }
  return (
    <div
      className="timecode mono"
      title={tr("player.goto")}
      onClick={() => {
        setText(formatTime(t, long));
        setEditing(true);
      }}
    >
      <span>{formatTime(t, long)}</span>
      <span className="total">/ {formatTime(duration, long)}</span>
    </div>
  );
}
