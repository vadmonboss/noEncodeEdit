import { useEffect, useRef, useState, type ReactNode } from "react";

export function Switch({ on, onChange, title }: { on: boolean; onChange: (v: boolean) => void; title?: string }) {
  return (
    <button
      type="button"
      className={`switch ${on ? "on" : ""}`}
      title={title}
      aria-pressed={on}
      onClick={(e) => {
        e.stopPropagation();
        onChange(!on);
      }}
    />
  );
}

export function Modal({
  children,
  onClose,
  size,
  closeOnScrim = true,
}: {
  children: ReactNode;
  onClose: () => void;
  size?: "sm" | "lg";
  closeOnScrim?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  return (
    <div
      className="scrim"
      onMouseDown={(e) => {
        if (closeOnScrim && e.target === e.currentTarget) onClose();
      }}
    >
      <div className={`modal ${size ?? ""}`} role="dialog" aria-modal="true">
        {children}
      </div>
    </div>
  );
}

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  kbd?: string;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
}

/** A button that opens a small popup menu. */
export function MenuButton({
  button,
  items,
  align = "right",
  up = false,
}: {
  button: (open: boolean, toggle: () => void) => ReactNode;
  items: (MenuItem | "sep")[];
  align?: "left" | "right";
  up?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div className="menu-wrap" ref={ref}>
      {button(open, () => setOpen((o) => !o))}
      {open && (
        <div className={`menu ${align === "left" ? "left" : ""} ${up ? "up" : ""}`}>
          {items.map((it, i) =>
            it === "sep" ? (
              <hr key={i} />
            ) : (
              <button
                key={i}
                className={it.danger ? "danger" : ""}
                disabled={it.disabled}
                onClick={(e) => {
                  e.stopPropagation();
                  setOpen(false);
                  it.onClick();
                }}
              >
                {it.icon}
                <span>{it.label}</span>
                {it.kbd && <span className="kbd">{it.kbd}</span>}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}

export function Progress({ value }: { value: number }) {
  return (
    <div className="progress">
      <div style={{ width: `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%` }} />
    </div>
  );
}
