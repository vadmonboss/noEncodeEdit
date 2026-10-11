import { useState } from "react";
import { AudioLines, ListPlus, Replace, Tags } from "lucide-react";
import { set, updateTrack, useStore } from "../store";
import { useT } from "../i18n";
import { addExternalAudio } from "../controller";
import { baseName, trackLabel } from "../lib/media";
import { Modal } from "./ui";

/** Shown when an audio file is dropped onto an open video. */
export function AddAudioDialog({ path }: { path: string }) {
  const tr = useT();
  const tracks = useStore((s) => s.tracks);
  const mainAudio = tracks.filter((x) => x.kind === "audio" && x.source === "main");
  const close = () => set({ dialog: null });
  const name = baseName(path);

  return (
    <Modal onClose={close} size="sm">
      <div className="modal-head">
        <div className="ic">
          <AudioLines size={20} />
        </div>
        <h2 style={{ fontSize: 17 }}>{tr("tracks.addAs", { name })}</h2>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <button
          className="choice"
          onClick={() => {
            close();
            void addExternalAudio(path);
          }}
        >
          <span className="ic">
            <ListPlus size={17} />
          </span>
          <span>
            <b>{tr("tracks.addNew")}</b>
            <span>{tr("tracks.addNewHint")}</span>
          </span>
        </button>
        {mainAudio.map((a, i) => (
          <button
            key={a.id}
            className="choice"
            onClick={() => {
              close();
              void addExternalAudio(path, a.id);
            }}
          >
            <span className="ic">
              <Replace size={17} />
            </span>
            <span>
              <b>{tr("tracks.replace", { name: `${tr("tracks.audio")} ${i + 1} · ${trackLabel(a)}${a.language ? ` · ${a.language}` : ""}` })}</b>
              <span>{tr("tracks.replaceHint")}</span>
            </span>
          </button>
        ))}
      </div>
      <div className="modal-foot">
        <button className="btn btn-soft" onClick={close}>
          {tr("tracks.cancel")}
        </button>
      </div>
    </Modal>
  );
}

export function TrackMetaDialog({ trackId }: { trackId: string }) {
  const tr = useT();
  const track = useStore((s) => s.tracks.find((x) => x.id === trackId));
  const [language, setLanguage] = useState(track?.language ?? "");
  const [title, setTitle] = useState(track?.title ?? "");
  const close = () => set({ dialog: null });
  if (!track) return null;

  const save = () => {
    updateTrack(track.id, { language: language.trim().toLowerCase().slice(0, 8), title: title.trim() });
    close();
  };

  return (
    <Modal onClose={close} size="sm">
      <div className="modal-head">
        <div className="ic">
          <Tags size={20} />
        </div>
        <div>
          <h2 style={{ fontSize: 17 }}>{tr("tracks.meta").replace("…", "")}</h2>
          <div className="muted" style={{ fontSize: 12.5 }}>
            {track.source === "external" ? track.fileName : trackLabel(track)}
          </div>
        </div>
      </div>
      <div className="form-row">
        <label className="field-label">{tr("tracks.language")}</label>
        <input
          className="input"
          autoFocus
          value={language}
          maxLength={8}
          onChange={(e) => setLanguage(e.target.value.replace(/[^a-zA-Z-]/g, ""))}
          onKeyDown={(e) => e.key === "Enter" && save()}
        />
        <div className="chips" style={{ marginTop: 8 }}>
          {["rus", "eng", "ukr", "deu", "fra", "spa", "jpn"].map((l) => (
            <button key={l} className={`chip ${language === l ? "on" : ""}`} onClick={() => setLanguage(l)}>
              {l}
            </button>
          ))}
        </div>
      </div>
      <div className="form-row">
        <label className="field-label">{tr("tracks.trackTitle")}</label>
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === "Enter" && save()} />
      </div>
      <div className="modal-foot">
        <button className="btn btn-soft" onClick={close}>
          {tr("tracks.cancel")}
        </button>
        <button className="btn btn-primary" onClick={save}>
          {tr("tracks.save")}
        </button>
      </div>
    </Modal>
  );
}
