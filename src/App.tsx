/**
 * App — the Subunit desktop shell.
 *
 * One coherent dark glass app: a left module rail + a top titlebar over a routed
 * module surface. Five modules (Atlas, Synapse, Chat, Call, Echo) each map to a
 * route; the Atlas + Synapse surfaces are authored by a sibling agent and loaded
 * via routes/ModuleHost, the rest live in src/modules. A ⌘K / Ctrl+K command
 * palette jumps between modules and runs quick actions.
 *
 * HashRouter (not BrowserRouter) so deep links work from the file:// origin a
 * bundled Tauri app serves the frontend from.
 */

import { useCallback, useEffect, useState } from "react";
import { HashRouter, Navigate, Route, Routes } from "react-router-dom";
import { Sidebar } from "./components/Sidebar";
import { TopBar } from "./components/TopBar";
import { CommandPalette } from "./components/CommandPalette";
import { DEFAULT_ROUTE } from "./lib/modules";
import { appVersion } from "./lib/ipc";
import { AtlasRoute, SynapseRoute } from "./routes/ModuleHost";
import ChatModule from "./modules/Chat";
import CallModule from "./modules/Call";
import EchoModule from "./modules/Echo";

function Shell() {
  const [version, setVersion] = useState("");
  const [paletteOpen, setPaletteOpen] = useState(false);

  useEffect(() => {
    appVersion().then(setVersion).catch(() => setVersion("dev"));
  }, []);

  // Global ⌘K / Ctrl+K toggles the palette from anywhere.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const openPalette = useCallback(() => setPaletteOpen(true), []);
  const closePalette = useCallback(() => setPaletteOpen(false), []);

  return (
    <div className="shell">
      <Sidebar version={version} />
      <div className="shell-main">
        <TopBar onOpenPalette={openPalette} />
        <main className="surface">
          <Routes>
            <Route path="/" element={<Navigate to={DEFAULT_ROUTE} replace />} />
            <Route path="/atlas" element={<AtlasRoute />} />
            <Route path="/synapse" element={<SynapseRoute />} />
            <Route path="/chat" element={<ChatModule />} />
            <Route path="/call" element={<CallModule />} />
            <Route path="/echo" element={<EchoModule />} />
            <Route path="*" element={<Navigate to={DEFAULT_ROUTE} replace />} />
          </Routes>
        </main>
      </div>
      <CommandPalette open={paletteOpen} onClose={closePalette} />
    </div>
  );
}

export function App() {
  return (
    <HashRouter>
      <Shell />
    </HashRouter>
  );
}

export default App;
