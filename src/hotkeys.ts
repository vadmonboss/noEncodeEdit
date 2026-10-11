import { engine } from "./engine";
import { get, redo, set, undo } from "./store";
import {
  deleteFragment,
  fitView,
  jumpBoundary,
  jumpKeyframe,
  markIn,
  markOut,
  pickAndOpenMedia,
  saveProject,
  selectFragment,
  setSelectedEdge,
  zoomAt,
} from "./controller";

function typingInField(e: KeyboardEvent) {
  const el = e.target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

export function installHotkeys() {
  const onKey = (e: KeyboardEvent) => {
    const s = get();
    const ctrl = e.ctrlKey || e.metaKey;
    const key = e.key;
    const code = e.code;

    // Global shortcuts that also work without media.
    if (ctrl && code === "KeyO") {
      e.preventDefault();
      void pickAndOpenMedia();
      return;
    }
    if (key === "F1") {
      e.preventDefault();
      set({ helpOpen: true });
      return;
    }
    if (s.exportOpen || s.helpOpen || s.dialog) return;
    if (typingInField(e)) return;
    if (!s.media) return;

    if (ctrl) {
      if (code === "KeyS") {
        e.preventDefault();
        void saveProject(e.shiftKey);
      } else if (code === "KeyZ" && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if (code === "KeyY" || (code === "KeyZ" && e.shiftKey)) {
        e.preventDefault();
        redo();
      } else if (code === "KeyE") {
        e.preventDefault();
        if (s.fragments.some((f) => f.end !== null)) set({ exportOpen: true });
      } else if (key === "ArrowLeft") {
        e.preventDefault();
        void jumpKeyframe(-1);
      } else if (key === "ArrowRight") {
        e.preventDefault();
        void jumpKeyframe(1);
      }
      return;
    }

    // Layout-independent letter keys (works on the Russian layout too).
    switch (code) {
      case "Space":
        e.preventDefault();
        engine.toggle();
        return;
      case "KeyI":
        e.preventDefault();
        if (e.shiftKey) void setSelectedEdge("start", e.altKey);
        else void markIn(e.altKey);
        return;
      case "KeyO":
        e.preventDefault();
        if (e.shiftKey) void setSelectedEdge("end");
        else markOut();
        return;
      case "KeyM":
        engine.toggleMute();
        return;
      case "BracketLeft":
        if (s.activeId) selectFragment(s.activeId, "start");
        return;
      case "BracketRight":
        if (s.activeId) selectFragment(s.activeId, "end");
        return;
      case "Backslash":
        fitView();
        return;
      case "Equal":
      case "NumpadAdd":
        zoomAt(1.6);
        return;
      case "Minus":
      case "NumpadSubtract":
        zoomAt(1 / 1.6);
        return;
    }

    switch (key) {
      case "ArrowLeft":
        e.preventDefault();
        if (e.shiftKey) engine.seek(s.currentTime - 1);
        else engine.step(-1);
        return;
      case "ArrowRight":
        e.preventDefault();
        if (e.shiftKey) engine.seek(s.currentTime + 1);
        else engine.step(1);
        return;
      case "ArrowUp":
        e.preventDefault();
        jumpBoundary(-1);
        return;
      case "ArrowDown":
        e.preventDefault();
        jumpBoundary(1);
        return;
      case "Home":
        e.preventDefault();
        engine.seek(0);
        return;
      case "End":
        e.preventDefault();
        engine.seek(s.media.duration);
        return;
      case "Delete":
      case "Backspace":
        e.preventDefault();
        deleteFragment();
        return;
      case "Escape":
        set({ activeId: null });
        return;
    }
  };
  // Alt alone toggles the (invisible) menu focus in WebView2; swallow it.
  const onKeyUp = (e: KeyboardEvent) => {
    if (e.key === "Alt") e.preventDefault();
  };
  window.addEventListener("keydown", onKey);
  window.addEventListener("keyup", onKeyUp);
  return () => {
    window.removeEventListener("keydown", onKey);
    window.removeEventListener("keyup", onKeyUp);
  };
}
