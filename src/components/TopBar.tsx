import {
  ChevronDown,
  FileVideo,
  FolderOpen,
  Keyboard,
  Moon,
  Music2,
  Redo2,
  Save,
  FolderInput,
  Sun,
  Undo2,
  X,
  FilePlus2,
} from "lucide-react";
import logo from "../assets/logo.svg";
import { set, setLang, setTheme, undo, redo, useStore } from "../store";
import { useT } from "../i18n";
import { closeMedia, pickAndOpenMedia, pickAndOpenProject, saveProject } from "../controller";
import { MenuButton } from "./ui";
import { formatBytes, formatDuration } from "../lib/time";
import { hasVideoTrack } from "../store";

export default function TopBar() {
  const tr = useT();
  const media = useStore((s) => s.media);
  const tracks = useStore((s) => s.tracks);
  const theme = useStore((s) => s.theme);
  const lang = useStore((s) => s.lang);
  const canUndo = useStore((s) => s.past.length > 0);
  const canRedo = useStore((s) => s.future.length > 0);
  const projectPath = useStore((s) => s.projectPath);
  const video = tracks.find((x) => x.kind === "video" && x.source === "main");
  const isVideo = hasVideoTrack(tracks);

  return (
    <header className="topbar">
      <div className="brand">
        <img src={logo} className="brand-logo" alt="" />
        <div>
          <div className="brand-name">
            no<span>Encode</span>Edit
          </div>
          <div className="brand-tag">{tr("app.tagline")}</div>
        </div>
      </div>

      {media && (
        <div className="file-chip" title={media.path}>
          {isVideo ? <FileVideo size={18} color="var(--accent)" /> : <Music2 size={18} color="var(--accent)" />}
          <span className="name">{media.name}</span>
          <span className="meta">
            {[
              formatDuration(media.duration),
              video?.width ? `${video.width}×${video.height}` : null,
              formatBytes(media.size),
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </div>
      )}

      <div className="spacer" />

      {media && (
        <div className="toolbar-group">
          <button className="icon-btn" title={tr("top.undo")} disabled={!canUndo} onClick={undo}>
            <Undo2 size={18} />
          </button>
          <button className="icon-btn" title={tr("top.redo")} disabled={!canRedo} onClick={redo}>
            <Redo2 size={18} />
          </button>
        </div>
      )}

      <button className="btn btn-ghost" title={tr("top.openTitle")} onClick={() => void pickAndOpenMedia()}>
        <FolderOpen size={17} />
        {tr("top.open")}
      </button>

      <MenuButton
        items={[
          { label: tr("top.openProject"), icon: <FolderInput size={16} />, onClick: () => void pickAndOpenProject() },
          {
            label: tr("top.saveProject"),
            icon: <Save size={16} />,
            kbd: "Ctrl+S",
            disabled: !media,
            onClick: () => void saveProject(false),
          },
          {
            label: tr("top.saveProjectAs"),
            icon: <FilePlus2 size={16} />,
            kbd: "Ctrl+Shift+S",
            disabled: !media,
            onClick: () => void saveProject(true),
          },
          "sep",
          { label: tr("top.closeFile"), icon: <X size={16} />, disabled: !media, onClick: () => void closeMedia() },
        ]}
        button={(_, toggle) => (
          <button className="btn btn-ghost" onClick={toggle} title={projectPath ?? undefined}>
            {tr("top.project")}
            <ChevronDown size={16} />
          </button>
        )}
      />

      <div className="toolbar-group">
        <button className="icon-btn" title={tr("top.help")} onClick={() => set({ helpOpen: true })}>
          <Keyboard size={18} />
        </button>
        <button
          className="icon-btn lang-btn"
          title={tr("top.lang")}
          onClick={() => setLang(lang === "ru" ? "en" : "ru")}
        >
          {lang === "ru" ? "RU" : "EN"}
        </button>
        <button
          className="icon-btn"
          title={tr("top.theme")}
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
        >
          {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
        </button>
      </div>
    </header>
  );
}
