import { Component, type ReactNode } from "react";

interface State {
  error: Error | null;
}

/** Keeps a rendering bug from leaving the user with a blank window. */
export default class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  render() {
    if (!this.state.error) return this.props.children;
    const ru = document.documentElement.lang !== "en";
    return (
      <div className="app" style={{ alignItems: "center", justifyContent: "center" }}>
        <div className="card" style={{ padding: 28, maxWidth: 560, textAlign: "center" }}>
          <h2 style={{ marginTop: 0 }}>{ru ? "Что-то пошло не так" : "Something went wrong"}</h2>
          <p className="muted">
            {ru
              ? "Интерфейс столкнулся с ошибкой. Файлы на диске не затронуты."
              : "The interface hit an error. Your files on disk are not affected."}
          </p>
          <div className="err-box">{String(this.state.error?.stack ?? this.state.error)}</div>
          <button className="btn btn-primary" style={{ marginTop: 16 }} onClick={() => location.reload()}>
            {ru ? "Перезапустить интерфейс" : "Restart interface"}
          </button>
        </div>
      </div>
    );
  }
}
