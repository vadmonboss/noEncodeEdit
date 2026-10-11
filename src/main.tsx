import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource-variable/nunito";
import "@fontsource-variable/jetbrains-mono";
import "./styles.css";
import App from "./App";
import ErrorBoundary from "./components/ErrorBoundary";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
