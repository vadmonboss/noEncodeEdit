import { AlertTriangle, CheckCircle2, Info, XCircle } from "lucide-react";
import { useStore } from "../store";

export default function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="toasts">
      {toasts.map((x) => (
        <div key={x.id} className={`toast ${x.kind}`}>
          {x.kind === "success" ? (
            <CheckCircle2 size={17} color="var(--ok)" />
          ) : x.kind === "warn" ? (
            <AlertTriangle size={17} color="var(--warn)" />
          ) : x.kind === "error" ? (
            <XCircle size={17} color="var(--danger)" />
          ) : (
            <Info size={17} color="var(--accent)" />
          )}
          <div>{x.text}</div>
        </div>
      ))}
    </div>
  );
}
