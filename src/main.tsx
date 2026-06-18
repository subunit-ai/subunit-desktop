/**
 * main.tsx — shell bootstrap.
 *
 * Sets the initial theme BEFORE first paint (anti-FOUC) from the persisted
 * preference (falling back to the OS color-scheme), then mounts <App/>. The App
 * wires the HostController + PluginLoader and discovers/mounts plugins; this
 * file does nothing module-specific — the shell is a thin host.
 */

import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import "./index.css";

// Anti-FOUC: resolve the theme and flip html.dark before React renders.
function initTheme(): void {
  let theme: "light" | "dark" = "light";
  try {
    const saved = localStorage.getItem("subunit.theme");
    if (saved === "light" || saved === "dark") {
      theme = saved;
    } else if (
      typeof matchMedia !== "undefined" &&
      matchMedia("(prefers-color-scheme: dark)").matches
    ) {
      theme = "dark";
    }
  } catch {
    /* storage / matchMedia unavailable — stay light */
  }
  document.documentElement.classList.toggle("dark", theme === "dark");
}

initTheme();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
