import { useRef, useState } from "react";
import { AlertTriangle, ArrowRightToLine, ArrowLeftToLine, MoreHorizontal, Play, Scissors, Trash2, Upload } from "lucide-react";
import { set, sortedFragments, useStore } from "../store";
import { useT } from "../i18n";
import {
  deleteFragment,
  describeKfShift,
  fmt,
  playFragment,
  selectFragment,
  setSelectedEdge,
  updateFragment,
} from "../controller";
import { formatDuration, parseTime } from "../lib/time";
import type { Fragment } from "../lib/types";
import { MenuButton } from "./ui";
import { ask } from "@tauri-apps/plugin-dialog";
import { checkpoint, commit } from "../store";

export default function FragmentsPanel() {
  const tr = useT();
  const fragments = useStore((s) => s.fragments);
  const activeId = useStore((s) => s.activeId);
  useStore((s) => s.keyframes); // re-render warnings when keyframes arrive
  const list = sortedFragments(fragments);
  const complete = list.filter((f) => f.end !== null);
  const total = complete.reduce((a, f) => a + (f.end! - f.start), 0);

  return (
    <section className="card fragments">
      <div className="panel-head">
        <span className="card-title">{tr("frag.title")}</span>
        {list.length > 0 && <span className="badge">{list.length}</span>}
        <div className="spacer" />
        {list.length > 0 && (
          <MenuButton
            items={[
              {
                label: tr("frag.clear"),
                icon: <Trash2 size={16} />,
                danger: true,
                onClick: async () => {
                  if (await ask(tr("frag.clearAsk"), { title: "noEncodeEdit", kind: "warning" })) {
                    commit({ fragments: [], activeId: null });
                  }
                },
              },
            ]}
            button={(_, toggle) => (
              <button className="icon-btn sm" onClick={toggle}>
                <MoreHorizontal size={17} />
              </button>
            )}
          />
        )}
      </div>

      {list.length === 0 ? (
        <div className="frag-empty">
          <div className="ic">
            <Scissors size={28} />
          </div>
          <b>{tr("frag.empty")}</b>
          <p>{tr("frag.emptyHint")}</p>
          <div className="row" style={{ marginTop: 6 }}>
            <kbd>I</kbd>
            <span className="faint">→</span>
            <kbd>O</kbd>
          </div>
        </div>
      ) : (
        <div className="frag-list">
          {list.map((f, i) => (
            <FragmentItem key={f.id} f={f} n={i + 1} active={f.id === activeId} />
          ))}
        </div>
      )}

      <div className="frag-foot">
        <div className="total">
          <span>{tr("frag.total", { d: formatDuration(total) })}</span>
          <span>{complete.length > 0 ? `${complete.length} ✓` : ""}</span>
        </div>
        <button
          className="btn btn-primary btn-lg btn-block"
          disabled={complete.length === 0}
          onClick={() => set({ exportOpen: true })}
        >
          <Upload size={18} />
          {complete.length > 0 ? tr("frag.exportN", { n: complete.length }) : tr("frag.export")}
        </button>
      </div>
    </section>
  );
}

function FragmentItem({ f, n, active }: { f: Fragment; n: number; active: boolean }) {
  const tr = useT();
  const labelEdited = useRef(false);
  const shift = describeKfShift(f.start);
  const draft = f.end === null;

  return (
    <div
      className={`frag ${active ? "active" : ""} ${draft ? "draft" : ""}`}
      onClick={() => selectFragment(f.id, "start")}
    >
      <div className="frag-num">{n}</div>
      <div className="frag-times mono">
        <EditableTime
          value={f.start}
          onCommit={(v) => {
            if (f.end !== null && v >= f.end - 0.01) return;
            updateFragment(f.id, { start: v });
          }}
        />
        <span className="arrow">→</span>
        {draft ? (
          <span className="faint">{tr("frag.draft")}</span>
        ) : (
          <EditableTime
            value={f.end!}
            onCommit={(v) => {
              if (v <= f.start + 0.01) return;
              updateFragment(f.id, { end: v });
            }}
          />
        )}
      </div>
      <div className="frag-actions" onClick={(e) => e.stopPropagation()}>
        {!draft && (
          <button className="icon-btn sm" title={tr("frag.play")} onClick={() => playFragment(f.id)}>
            <Play size={15} />
          </button>
        )}
        <MenuButton
          items={[
            {
              label: tr("frag.setIn"),
              icon: <ArrowRightToLine size={16} />,
              onClick: () => {
                selectFragment(f.id);
                void setSelectedEdge("start");
              },
            },
            {
              label: tr("frag.setOut"),
              icon: <ArrowLeftToLine size={16} />,
              onClick: () => {
                selectFragment(f.id);
                void setSelectedEdge("end");
              },
            },
            "sep",
            { label: tr("frag.delete"), icon: <Trash2 size={16} />, danger: true, onClick: () => deleteFragment(f.id) },
          ]}
          button={(_, toggle) => (
            <button className="icon-btn sm" onClick={toggle}>
              <MoreHorizontal size={16} />
            </button>
          )}
        />
      </div>
      <div className="frag-sub">
        {draft ? (
          <span className="faint">{tr("frag.waitOut")}</span>
        ) : (
          <span className="badge gray mono">{formatDuration(f.end! - f.start)}</span>
        )}
        {shift && (
          <span
            className="badge warn"
            title={tr("frag.kfWarn", { d: formatDuration(shift.shift), t: fmt(shift.at) })}
          >
            <AlertTriangle size={11} />
            −{formatDuration(shift.shift)}
          </span>
        )}
        <input
          className="frag-label-input"
          placeholder={tr("frag.label")}
          value={f.label}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter" || e.key === "Escape") (e.target as HTMLInputElement).blur();
          }}
          onFocus={() => (labelEdited.current = false)}
          onChange={(e) => {
            // One undo step per editing session, created on the first keystroke.
            if (!labelEdited.current) checkpoint();
            labelEdited.current = true;
            updateFragment(f.id, { label: e.target.value.replace(/[<>:"/\\|?*]/g, "") }, false);
          }}
        />
      </div>
    </div>
  );
}

function EditableTime({ value, onCommit }: { value: number; onCommit: (v: number) => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  if (editing) {
    return (
      <input
        className="frag-time-input mono"
        autoFocus
        value={text}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => setEditing(false)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") {
            const v = parseTime(text);
            if (v !== null) onCommit(v);
            setEditing(false);
          } else if (e.key === "Escape") setEditing(false);
        }}
      />
    );
  }
  return (
    <button
      className="frag-time mono"
      onClick={(e) => {
        e.stopPropagation();
        setText(fmt(value));
        setEditing(true);
      }}
    >
      {fmt(value)}
    </button>
  );
}
