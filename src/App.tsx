import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { ask } from "@tauri-apps/plugin-dialog";
import { useStore, get, set } from "./store";
import { api, initEvents } from "./lib/api";
import { handleDroppedPaths, openMedia, openProject, updateTitle } from "./controller";
import { installHotkeys } from "./hotkeys";
import { t } from "./i18n";
import TopBar from "./components/TopBar";
import EmptyState from "./components/EmptyState";
import Player from "./components/Player";
import FragmentsPanel from "./components/FragmentsPanel";
import Timeline from "./components/Timeline";
import ExportDialog from "./components/ExportDialog";
import HelpDialog from "./components/HelpDialog";
import { AddAudioDialog, TrackMetaDialog } from "./components/TrackDialogs";
import Toasts from "./components/Toasts";
import { Loader2 } from "lucide-react";

export default function App() {
  const media = useStore((s) => s.media);
  const loading = useStore((s) => s.loading);
  const exportOpen = useStore((s) => s.exportOpen);
  const helpOpen = useStore((s) => s.helpOpen);
  const dialog = useStore((s) => s.dialog);
  const theme = useStore((s) => s.theme);
  const lang = useStore((s) => s.lang);
  const dirty = useStore((s) => s.dirty);

  // One-time setup.
  useEffect(() => {
    document.documentElement.lang = get().lang;
    const win = getCurrentWindow();
    void win.show();
    void initEvents();
    const removeHotkeys = installHotkeys();

    let unDrop: (() => void) | undefined;
    void getCurrentWebview()
      .onDragDropEvent((e) => {
        const p = e.payload;
        if (p.type === "enter" || p.type === "over") set({ dragOver: true });
        else if (p.type === "leave") set({ dragOver: false });
        else if (p.type === "drop") {
          set({ dragOver: false });
          void handleDroppedPaths(p.paths);
        }
      })
      .then((u) => (unDrop = u));

    let unClose: (() => void) | undefined;
    void win
      .onCloseRequested(async (e) => {
        const s = get();
        if (s.dirty && s.media) {
          e.preventDefault();
          if (await ask(t("msg.unsaved"), { title: "noEncodeEdit", kind: "warning" })) await win.destroy();
        }
      })
      .then((u) => (unClose = u));

    void api.appInfo().then((info) => {
      set({ appInfo: info });
      if (info.launchFile) {
        if (info.launchFile.toLowerCase().endsWith(".nee")) void openProject(info.launchFile);
        else void openMedia(info.launchFile);
      }
    });

    return () => {
      removeHotkeys();
      unDrop?.();
      unClose?.();
    };
  }, []);

  useEffect(() => {
    void getCurrentWindow().setTheme(theme).catch(() => {});
  }, [theme]);

  useEffect(() => {
    updateTitle();
  }, [dirty, media, lang]);

  return (
    <div className="app">
      <TopBar />
      {loading ? (
        <div className="loading-screen card">
          <Loader2 className="spin" size={22} />
          {t("player.loading")}
        </div>
      ) : media ? (
        <div className="workspace">
          <Player />
          <FragmentsPanel />
          <Timeline />
        </div>
      ) : (
        <EmptyState />
      )}
      {exportOpen && media && <ExportDialog />}
      {helpOpen && <HelpDialog />}
      {dialog?.kind === "addAudio" && media && <AddAudioDialog path={dialog.path} />}
      {dialog?.kind === "trackMeta" && <TrackMetaDialog trackId={dialog.trackId} />}
      <Toasts />
    </div>
  );
}
