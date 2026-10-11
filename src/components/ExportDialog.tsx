import { useEffect, useMemo, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  AlertTriangle,
  CheckCircle2,
  Files,
  FolderOpen,
  Info,
  Layers,
  Loader2,
  Upload,
  XCircle,
  Zap,
} from "lucide-react";
import { get, set, sortedFragments, toast, useStore } from "../store";
import { useT } from "../i18n";
import { actualStart, actualStartSync, knownKeyframes } from "../controller";
import {
  api,
  CANCELLED,
  errText,
  newJobId,
  onExportProgress,
  type CompatResult,
  type ExportSpec,
} from "../lib/api";
import {
  AUDIO_CONTAINERS,
  joinPath,
  resolveContainer,
  seekMargin,
  seekQuirks,
  stem,
  trackLabel,
  VIDEO_CONTAINERS,
  type ContainerInfo,
} from "../lib/media";
import { fileTime, formatDuration } from "../lib/time";
import type { Fragment, MediaFile, Track } from "../lib/types";
import { Modal, Progress } from "./ui";

type Phase = "setup" | "running" | "done" | "error" | "cancelled";

function sanitize(name: string): string {
  return name
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/[ _.-]{2,}/g, (m) => m[0])
    .replace(/^[ _.-]+|[ _.-]+$/g, "")
    .slice(0, 180);
}

function renderName(template: string, media: MediaFile, f: Fragment | null, n: number, total: number): string {
  const pad = String(n).padStart(Math.max(2, String(total).length), "0");
  const out = template
    .replace(/\{name\}/g, stem(media.path))
    .replace(/\{n\}/g, pad)
    .replace(/\{label\}/g, f?.label ?? "")
    .replace(/\{in\}/g, f ? fileTime(f.start) : "")
    .replace(/\{out\}/g, f && f.end !== null ? fileTime(f.end) : "");
  return sanitize(out) || `${stem(media.path)}_${pad}`;
}

function buildTracks(tracks: Track[]): { inputs: string[]; specs: ExportSpec["tracks"]; media?: undefined } {
  const s = get();
  const enabled = tracks.filter((x) => x.enabled);
  const inputs = [s.media!.path];
  const firstAudio = enabled.find((x) => x.kind === "audio");
  const specs = enabled.map((x) => {
    let input = 0;
    if (x.source === "external") {
      input = inputs.indexOf(x.filePath);
      if (input < 0) {
        inputs.push(x.filePath);
        input = inputs.length - 1;
      }
    }
    const ext = x.source === "external";
    const language = ext ? x.language || null : x.language !== x.origLanguage ? x.language || "und" : null;
    const title = ext ? x.title || null : x.title !== x.origTitle ? x.title : null;
    return {
      input,
      streamIndex: x.streamIndex,
      kind: x.kind,
      offset: ext ? x.offset : 0,
      language,
      title,
      default: x.id === firstAudio?.id,
    };
  });
  return { inputs, specs };
}

export default function ExportDialog() {
  const tr = useT();
  const media = useStore((s) => s.media)!;
  const tracks = useStore((s) => s.tracks);
  const fragments = useStore((s) => s.fragments);
  const settings = useStore((s) => s.exportSettings);
  useStore((s) => s.keyframes);
  const [phase, setPhase] = useState<Phase>("setup");
  const [compat, setCompat] = useState<{ status: "checking" | "done"; result?: CompatResult }>({ status: "checking" });
  const [conflicts, setConflicts] = useState(0);
  const [overwrite, setOverwrite] = useState(false);
  const [progress, setProgress] = useState<{ index: number; fractions: number[]; overall: number }>({
    index: 0,
    fractions: [],
    overall: 0,
  });
  const [result, setResult] = useState<{ files: string[]; error?: string }>({ files: [] });
  const jobRef = useRef<string | null>(null);

  const patch = (p: Partial<typeof settings>) => set({ exportSettings: { ...get().exportSettings, ...p }, dirty: true });
  const close = () => {
    if (phase === "running") return;
    set({ exportOpen: false });
  };

  const complete = useMemo(() => sortedFragments(fragments).filter((f) => f.end !== null), [fragments]);
  const drafts = fragments.length - complete.length;
  const enabled = tracks.filter((x) => x.enabled);
  const hasVideoOut = enabled.some((x) => x.kind === "video");
  const container: ContainerInfo = resolveContainer(settings.container, media, hasVideoOut);
  const choices = hasVideoOut ? VIDEO_CONTAINERS : AUDIO_CONTAINERS;
  const merge = settings.mode === "merge";
  const totalDur = complete.reduce((a, f) => a + (f.end! - f.start), 0);
  const kfShifted = hasVideoOut
    ? complete.filter((f) => {
        const a = actualStartSync(f.start);
        return a !== null && f.start - a > 0.002;
      }).length
    : 0;

  const names = useMemo(() => {
    if (merge) return [`${renderName(settings.mergeTemplate, media, null, 1, 1)}.${container.ext}`];
    const raw = complete.map((f, i) => `${renderName(settings.template, media, f, i + 1, complete.length)}.${container.ext}`);
    // Make names unique inside the batch.
    const seen = new Map<string, number>();
    return raw.map((n) => {
      const k = n.toLowerCase();
      const c = (seen.get(k) ?? 0) + 1;
      seen.set(k, c);
      return c === 1 ? n : n.replace(/(\.[^.]+)$/, ` (${c})$1`);
    });
  }, [merge, settings.template, settings.mergeTemplate, complete, media, container.ext]);
  const paths = names.map((n) => joinPath(settings.dir, n));

  // Existing files.
  useEffect(() => {
    if (!settings.dir) return setConflicts(0);
    let alive = true;
    void api.pathsExist(paths).then((ex) => alive && setConflicts(ex.filter(Boolean).length));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paths.join("|")]);

  // Compatibility dry run.
  const compatKey = JSON.stringify([container.ext, enabled.map((x) => [x.id, x.offset])]);
  useEffect(() => {
    if (enabled.length === 0) return;
    let alive = true;
    setCompat({ status: "checking" });
    const { inputs, specs } = buildTracks(get().tracks);
    const spec: ExportSpec = { inputs, tracks: specs, fragments: [], format: container.muxer, faststart: false, ...seekQuirks(media) };
    const timer = window.setTimeout(() => {
      void api
        .testCompat(spec, container.ext)
        .then((r) => alive && setCompat({ status: "done", result: r }))
        .catch((e) => alive && setCompat({ status: "done", result: { ok: false, error: errText(e), tracks: [] } }));
    }, 250);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compatKey]);

  async function resolvePaths(): Promise<string[]> {
    const out = [...paths];
    const srcLower = media.path.toLowerCase();
    for (let i = 0; i < out.length; i++) {
      const needsFree = out[i].toLowerCase() === srcLower || (!overwrite && (await api.pathsExist([out[i]]))[0]);
      if (!needsFree) continue;
      const base = out[i].replace(/(\.[^.\\/]+)$/, "");
      const ext = out[i].slice(base.length);
      for (let k = 2; k < 1000; k++) {
        const cand = `${base} (${k})${ext}`;
        if (out.some((p, j) => j !== i && p.toLowerCase() === cand.toLowerCase())) continue;
        if (cand.toLowerCase() === srcLower) continue;
        if (!(await api.pathsExist([cand]))[0]) {
          out[i] = cand;
          break;
        }
      }
    }
    return out;
  }

  async function run() {
    const outPaths = await resolvePaths();
    const { inputs, specs } = buildTracks(get().tracks);
    const frags = [];
    for (let i = 0; i < complete.length; i++) {
      const f = complete[i];
      const videoStart = hasVideoOut ? await actualStart(f.start) : f.start;
      frags.push({
        start: f.start,
        end: f.end!,
        videoStart,
        outPath: merge ? "" : outPaths[i],
        seekMargin: seekMargin(knownKeyframes(), videoStart),
      });
    }
    const spec: ExportSpec = {
      inputs,
      tracks: specs,
      fragments: frags,
      format: container.muxer,
      faststart: settings.faststart,
      mergePath: merge ? outPaths[0] : null,
      ...seekQuirks(media),
    };
    const jobId = newJobId("export");
    jobRef.current = jobId;
    setProgress({ index: 0, fractions: complete.map(() => 0), overall: 0 });
    setPhase("running");
    const off = onExportProgress(jobId, (p) =>
      setProgress((prev) => {
        const fractions = [...prev.fractions];
        if (p.index < fractions.length) {
          fractions[p.index] = p.fraction;
          for (let i = 0; i < p.index; i++) fractions[i] = 1;
        } else for (let i = 0; i < fractions.length; i++) fractions[i] = 1;
        return { index: p.index, fractions, overall: p.overall };
      }),
    );
    try {
      const r = await api.exportFragments(jobId, spec);
      setResult({ files: r.files });
      setPhase("done");
      set({ dirty: false });
      toast(tr("msg.exported", { n: r.files.length }), "success");
    } catch (e) {
      const msg = errText(e);
      if (msg === CANCELLED) {
        setPhase("cancelled");
      } else {
        setResult({ files: [], error: msg });
        setPhase("error");
      }
    } finally {
      off();
      jobRef.current = null;
    }
  }

  const trackName = (x: Track) =>
    x.source === "external"
      ? x.fileName
      : `${x.kind === "video" ? tr("tracks.video") : x.kind === "audio" ? tr("tracks.audio") : tr("tracks.subtitle")} · ${trackLabel(x)}`;

  // ---------------------------------------------------------------- running
  if (phase === "running") {
    return (
      <Modal onClose={() => {}} closeOnScrim={false}>
        <div className="modal-head">
          <div className="ic">
            <Loader2 size={20} className="spin" />
          </div>
          <h2>{tr("export.running")}</h2>
        </div>
        <div className="big-progress">
          <div className="row">
            <span>{merge && progress.index >= complete.length ? tr("export.merging") : tr("export.fragment", { n: Math.min(progress.index + 1, complete.length) })}</span>
            <span className="mono">{Math.round(progress.overall * 100)}%</span>
          </div>
          <Progress value={progress.overall} />
        </div>
        <div className="export-progress">
          {complete.map((f, i) => {
            const fr = progress.fractions[i] ?? 0;
            return (
              <div key={f.id} className={`export-item ${fr >= 1 ? "done" : i === progress.index ? "run" : ""}`}>
                <span className="num">{i + 1}</span>
                <Progress value={fr} />
                <span className="pct mono">{Math.round(fr * 100)}%</span>
              </div>
            );
          })}
        </div>
        <div className="modal-foot">
          <button className="btn btn-soft" onClick={() => jobRef.current && void api.cancelJob(jobRef.current)}>
            {tr("export.cancel")}
          </button>
        </div>
      </Modal>
    );
  }

  // ---------------------------------------------------------------- finished
  if (phase === "done" || phase === "error" || phase === "cancelled") {
    const ok = phase === "done";
    return (
      <Modal onClose={close} size="sm">
        <div className={`done-state ${ok ? "" : "fail"}`}>
          <div className="ic">{ok ? <CheckCircle2 size={36} /> : <XCircle size={36} />}</div>
          <h3>{ok ? tr("export.done") : phase === "cancelled" ? tr("export.cancelled") : tr("export.failed")}</h3>
          {ok && <div className="muted">{tr("export.doneText", { n: result.files.length })}</div>}
          {ok && (
            <div className="file-list">
              {result.files.map((f) => (
                <div key={f} title={f}>
                  {f.split(/[\\/]/).pop()}
                </div>
              ))}
            </div>
          )}
          {result.error && <div className="err-box">{result.error}</div>}
        </div>
        <div className="modal-foot" style={{ justifyContent: "center" }}>
          {ok && result.files[0] && (
            <button className="btn btn-accent-soft" onClick={() => void api.revealPath(result.files[0])}>
              <FolderOpen size={16} />
              {tr("export.openFolder")}
            </button>
          )}
          {!ok && (
            <button className="btn btn-soft" onClick={() => setPhase("setup")}>
              ←
            </button>
          )}
          <button className="btn btn-primary" onClick={close}>
            {tr("export.close")}
          </button>
        </div>
      </Modal>
    );
  }

  // ---------------------------------------------------------------- setup
  const blocking =
    enabled.length === 0
      ? tr("export.noTracks")
      : complete.length === 0
        ? tr("export.noFragments")
        : !settings.dir
          ? tr("export.noFolder")
          : null;
  const compatFail = compat.status === "done" && compat.result && !compat.result.ok;
  const failErrors = compatFail ? [...new Set(compat.result!.tracks.filter((x) => !x.ok).map((x) => x.error ?? ""))] : [];
  const sharedError = failErrors.length === 1 && compat.result!.tracks.filter((x) => !x.ok).length > 1 ? failErrors[0] : null;

  return (
    <Modal onClose={close}>
      <div className="modal-head">
        <div className="ic">
          <Upload size={20} />
        </div>
        <div style={{ flex: 1 }}>
          <h2>{tr("export.title")}</h2>
          <div className="muted" style={{ fontSize: 12.5, display: "flex", alignItems: "center", gap: 6 }}>
            <Zap size={13} color="var(--accent)" />
            {tr("export.streamCopy")} · {tr("export.summary", { n: complete.length, d: formatDuration(totalDur) })}
          </div>
        </div>
      </div>

      <div className="form-row">
        <label className="field-label">{tr("export.mode")}</label>
        <div className="choice-grid">
          <button className={`choice ${!merge ? "on" : ""}`} onClick={() => patch({ mode: "separate" })}>
            <span className="ic">
              <Files size={17} />
            </span>
            <span>
              <b>{tr("export.separate")}</b>
              <span>{tr("export.separateHint")}</span>
            </span>
          </button>
          <button className={`choice ${merge ? "on" : ""}`} onClick={() => patch({ mode: "merge" })}>
            <span className="ic">
              <Layers size={17} />
            </span>
            <span>
              <b>{tr("export.merge")}</b>
              <span>{tr("export.mergeHint")}</span>
            </span>
          </button>
        </div>
      </div>

      <div className="form-row">
        <label className="field-label">{tr("export.folder")}</label>
        <div className="row">
          <input className="input" value={settings.dir} onChange={(e) => patch({ dir: e.target.value })} spellCheck={false} />
          <button
            className="btn btn-accent-soft"
            onClick={async () => {
              const d = await openDialog({ directory: true, defaultPath: settings.dir || undefined });
              if (typeof d === "string") patch({ dir: d });
            }}
          >
            <FolderOpen size={16} />
            {tr("export.choose")}
          </button>
        </div>
      </div>

      <div className="form-row">
        <label className="field-label">{tr("export.container")}</label>
        <div className="chips">
          <button
            className={`chip ${settings.container === "source" ? "on" : ""}`}
            onClick={() => patch({ container: "source" })}
          >
            {tr("export.sameAsSource")} ({resolveContainer("source", media, hasVideoOut).label})
          </button>
          {choices.map((c) => (
            <button
              key={c.ext}
              className={`chip ${settings.container === c.ext ? "on" : ""}`}
              onClick={() => patch({ container: c.ext })}
            >
              {c.label}
            </button>
          ))}
        </div>
        {compat.status === "checking" && enabled.length > 0 && (
          <div className="note">
            <Loader2 size={15} className="spin" />
            {tr("export.checking")}
          </div>
        )}
        {compat.status === "done" && compat.result?.ok && (
          <div className="note ok">
            <CheckCircle2 size={15} />
            {tr("export.compatOk", { fmt: container.label })}
          </div>
        )}
        {compatFail && (
          <div className="note danger">
            <XCircle size={15} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <b>{tr("export.compatFail", { fmt: container.label })}</b>
              <div className="compat-list">
                {compat.result!.tracks.length > 0
                  ? enabled.map((x, i) => {
                      const r = compat.result!.tracks[i];
                      if (!r || r.ok) return null;
                      return (
                        <div key={x.id}>
                          <div className="compat-item">
                            <AlertTriangle size={13} />
                            <span style={{ flex: 1 }}>{trackName(x)}</span>
                            <button
                              className="btn btn-soft btn-sm"
                              onClick={() => {
                                const tracksNow = get().tracks.map((y) => (y.id === x.id ? { ...y, enabled: false } : y));
                                set({ tracks: tracksNow, dirty: true });
                              }}
                            >
                              {tr("export.disableTrack")}
                            </button>
                          </div>
                          {!sharedError && <div className="detail">{r.error}</div>}
                        </div>
                      );
                    })
                  : <div className="detail">{compat.result!.error}</div>}
                {sharedError && <div className="detail">{sharedError}</div>}
              </div>
              {container.muxer !== "matroska" && (
                <div className="note-actions">
                  <button
                    className="btn btn-accent-soft btn-sm"
                    onClick={() => patch({ container: hasVideoOut ? "mkv" : "mka" })}
                  >
                    {tr("export.useMkv")}
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="form-row">
        <label className="field-label">{tr("export.name")}</label>
        <input
          className="input mono"
          style={{ fontSize: 13 }}
          spellCheck={false}
          value={merge ? settings.mergeTemplate : settings.template}
          onChange={(e) => patch(merge ? { mergeTemplate: e.target.value } : { template: e.target.value })}
        />
        <div className="preview-name" title={names.join("\n")}>
          {tr("export.preview")}: <b>{names[0]}</b>
          {names.length > 1 ? ` … ${names[names.length - 1]}` : ""}
        </div>
        <div className="preview-name faint" style={{ fontSize: 11.5 }}>
          {tr("export.nameHint")}
        </div>
      </div>

      {(container.muxer === "mp4" || container.muxer === "mov" || container.muxer === "ipod") && (
        <label className="check" style={{ marginBottom: 6 }}>
          <input type="checkbox" checked={settings.faststart} onChange={(e) => patch({ faststart: e.target.checked })} />
          {tr("export.faststart")}
        </label>
      )}

      {conflicts > 0 && (
        <div className="note warn">
          <AlertTriangle size={15} />
          <div style={{ flex: 1 }}>
            {tr("export.conflicts", { n: conflicts })}
            <div className="note-actions">
              <div className="seg">
                <button className={!overwrite ? "on" : ""} onClick={() => setOverwrite(false)}>
                  {tr("export.addNumber")}
                </button>
                <button className={overwrite ? "on" : ""} onClick={() => setOverwrite(true)}>
                  {tr("export.overwrite")}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      {kfShifted > 0 && (
        <div className="note warn">
          <AlertTriangle size={15} />
          {tr("export.kfNote", { n: kfShifted })}
        </div>
      )}
      {drafts > 0 && (
        <div className="note">
          <Info size={15} />
          {tr("export.drafts", { n: drafts })}
        </div>
      )}

      <div className="modal-foot">
        {blocking && <span className="muted" style={{ marginRight: "auto", fontSize: 13 }}>{blocking}</span>}
        <button className="btn btn-soft" onClick={close}>
          {tr("export.cancel")}
        </button>
        <button className="btn btn-primary" disabled={!!blocking || !!compatFail} onClick={() => void run()}>
          <Upload size={17} />
          {tr("export.start")}
        </button>
      </div>
    </Modal>
  );
}
