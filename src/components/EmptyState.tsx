import { useState } from "react";
import { AudioLines, Clock3, FileVideo, FolderInput, FolderOpen, Layers, Scissors, Upload, X, Zap } from "lucide-react";
import { useStore } from "../store";
import { useT } from "../i18n";
import { loadRecent, openMedia, pickAndOpenMedia, pickAndOpenProject, removeRecent } from "../controller";
import { dirName } from "../lib/media";

export default function EmptyState() {
  const tr = useT();
  const dragOver = useStore((s) => s.dragOver);
  const [recent, setRecent] = useState(loadRecent);
  const lang = useStore((s) => s.lang);

  const features =
    lang === "ru"
      ? [
          { ic: <Zap size={17} />, b: "Без перекодирования", s: "Работает через FFmpeg stream copy: быстро и без потери качества" },
          { ic: <Scissors size={17} />, b: "Сколько угодно фрагментов", s: "Отметьте In/Out несколько раз и сохраните всё за один раз" },
          { ic: <AudioLines size={17} />, b: "Аудиодорожки", s: "Замена, добавление и отключение дорожек, сдвиг внешнего звука" },
          { ic: <Layers size={17} />, b: "Склейка", s: "Сохраните фрагменты отдельными файлами или одним" },
        ]
      : [
          { ic: <Zap size={17} />, b: "No re-encoding", s: "FFmpeg stream copy: fast and lossless" },
          { ic: <Scissors size={17} />, b: "Any number of fragments", s: "Mark In/Out as many times as you like and export all at once" },
          { ic: <AudioLines size={17} />, b: "Audio tracks", s: "Replace, add or disable tracks, offset external audio" },
          { ic: <Layers size={17} />, b: "Merging", s: "Save fragments as separate files or as one" },
        ];

  return (
    <div className="empty">
      <div className={`card dropzone ${dragOver ? "over" : ""}`}>
        <div className="drop-icon">{dragOver ? <Upload size={42} /> : <FileVideo size={42} />}</div>
        <h1>{dragOver ? tr("empty.dropNow") : tr("empty.title")}</h1>
        <p>{tr("empty.subtitle")}</p>
        <div className="actions">
          <button className="btn btn-primary btn-lg" onClick={() => void pickAndOpenMedia()}>
            <FolderOpen size={18} />
            {tr("empty.open")}
          </button>
          <button className="btn btn-ghost btn-lg" onClick={() => void pickAndOpenProject()}>
            <FolderInput size={18} />
            {tr("empty.openProject")}
          </button>
        </div>
        <div className="hints">
          <span>
            <kbd>I</kbd> {tr("empty.hint1")}
          </span>
          <span>
            <kbd>O</kbd> {tr("empty.hint2")}
          </span>
          <span>
            <kbd>Space</kbd> {tr("empty.hint3")}
          </span>
        </div>
      </div>

      <div className="card side-panel">
        {recent.length > 0 ? (
          <>
            <div className="card-title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Clock3 size={17} color="var(--accent)" />
              {tr("empty.recent")}
            </div>
            <div className="recent-list">
              {recent.map((r) => (
                <div key={r.path} style={{ position: "relative" }}>
                  <button className="recent-item" title={r.path} onClick={() => void openMedia(r.path)}>
                    <span className="ic">
                      <FileVideo size={18} />
                    </span>
                    <span style={{ minWidth: 0, flex: 1 }}>
                      <div className="nm">{r.name}</div>
                      <div className="pt">{dirName(r.path)}</div>
                    </span>
                  </button>
                  <button
                    className="icon-btn sm"
                    style={{ position: "absolute", right: 6, top: 14 }}
                    onClick={() => {
                      removeRecent(r.path);
                      setRecent(loadRecent());
                    }}
                  >
                    <X size={14} />
                  </button>
                </div>
              ))}
            </div>
            <div style={{ flex: 1 }} />
          </>
        ) : null}
        <div style={{ marginTop: recent.length ? 12 : 0 }}>
          {features.map((f) => (
            <div className="feature" key={f.b}>
              <span className="ic">{f.ic}</span>
              <div>
                <b>{f.b}</b>
                <span>{f.s}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
