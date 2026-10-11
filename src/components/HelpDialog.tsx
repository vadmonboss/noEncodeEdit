import { ExternalLink, Info, Keyboard } from "lucide-react";
import { set, useStore } from "../store";
import { api } from "../lib/api";
import { REPO_URL } from "../lib/about";
import { useT, type TKey } from "../i18n";
import { Modal } from "./ui";

const KEYS: [string[][], TKey][] = [
  [[["Space"]], "help.play"],
  [[["I"]], "help.in"],
  [[["Alt", "I"]], "help.inFree"],
  [[["O"]], "help.out"],
  [[["Shift", "I"], ["Shift", "O"]], "help.setSel"],
  [[["←"], ["→"]], "help.frame"],
  [[["Shift", "←"], ["Shift", "→"]], "help.second"],
  [[["Ctrl", "←"], ["Ctrl", "→"]], "help.key"],
  [[["↑"], ["↓"]], "help.boundary"],
  [[["["], ["]"]], "help.jumpSel"],
  [[["Home"], ["End"]], "help.homeEnd"],
  [[["Del"]], "help.delete"],
  [[["Ctrl", "Z"], ["Ctrl", "Y"]], "help.undo"],
  [[["+"], ["−"], ["\\"]], "help.zoom"],
  [[["M"]], "help.mute"],
  [[["Ctrl", "O"], ["Ctrl", "S"]], "help.open"],
  [[["Ctrl", "E"]], "help.export"],
];

export default function HelpDialog() {
  const tr = useT();
  const close = () => set({ helpOpen: false });
  const version = useStore((s) => s.appInfo?.version);
  return (
    <Modal onClose={close} size="lg">
      <div className="modal-head">
        <div className="ic">
          <Keyboard size={20} />
        </div>
        <h2>{tr("help.title")}</h2>
      </div>
      <div className="keys">
        {KEYS.map(([combos, label]) => (
          <div key={label} style={{ display: "contents" }}>
            <div className="k">
              {combos.map((combo, i) => (
                <span key={i} style={{ display: "inline-flex", gap: 3, alignItems: "center" }}>
                  {i > 0 && <span className="faint" style={{ margin: "0 3px" }}>/</span>}
                  {combo.map((k) => (
                    <kbd key={k}>{k}</kbd>
                  ))}
                </span>
              ))}
            </div>
            <div>{tr(label)}</div>
          </div>
        ))}
      </div>
      <div className="note" style={{ marginTop: 18 }}>
        <Info size={15} />
        <div>
          <div>{tr("help.drag")}</div>
          <div style={{ marginTop: 6 }}>{tr("help.kfNote")}</div>
        </div>
      </div>
      <div className="modal-foot">
        <span className="muted" style={{ marginRight: "auto", fontSize: 12.5 }}>
          noEncodeEdit {version ? `v${version}` : ""} · GPL-3.0
        </span>
        <button className="btn btn-accent-soft btn-sm" onClick={() => void api.openUrl(REPO_URL)}>
          <ExternalLink size={14} />
          GitHub
        </button>
        <button className="btn btn-primary" onClick={close}>
          OK
        </button>
      </div>
    </Modal>
  );
}
