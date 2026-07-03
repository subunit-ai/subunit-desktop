/**
 * XtermView — echtes Terminal (xterm.js) an einem lokalen PTY.
 *
 * Ersetzt die frühere <pre>-Approximation im TerminalPane: voll interaktiv
 * (Tastatur geht direkt in die PTY — auch TUI-Apps wie `claude` laufen echt),
 * FitAddon + ResizeObserver halten die PTY-Größe synchron (`resize_terminal`).
 * Theme folgt dem Liquid-Glass-Hell/Dunkel-Schalter live.
 */
import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { HostApi } from "../../plugin/types";

const THEMES = {
  dark: {
    background: "#0c1218",
    foreground: "#dbe7f0",
    cursor: "#22d3ee",
    cursorAccent: "#0c1218",
    selectionBackground: "rgba(34,211,238,.30)",
  },
  light: {
    background: "#f6f9fc",
    foreground: "#1c2733",
    cursor: "#0891b2",
    cursorAccent: "#f6f9fc",
    selectionBackground: "rgba(8,145,178,.25)",
  },
} as const;

export function XtermView({ host, termId }: { host: HostApi; termId: string }) {
  const elRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = elRef.current;
    if (!el) return;
    const xt = new Terminal({
      fontSize: 12.5,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      cursorBlink: true,
      scrollback: 8000,
      theme: THEMES[host.ui.theme()],
    });
    const fit = new FitAddon();
    xt.loadAddon(fit);
    xt.open(el);

    const offTheme = host.ui.onTheme((t) => {
      xt.options.theme = THEMES[t];
    });
    const offOut = host.terminals.onOutput(termId, (chunk) => xt.write(chunk));
    const offExit = host.terminals.onExit(termId, (code) =>
      xt.write(`\r\n\x1b[2m[Prozess beendet, Code ${code}]\x1b[0m\r\n`)
    );
    const onData = xt.onData((data) => {
      void host.terminals.write(termId, data).catch(() => {});
    });

    const doFit = () => {
      try {
        fit.fit();
      } catch {
        return;
      }
      void host.terminals.resize(termId, xt.rows, xt.cols).catch(() => {});
    };
    doFit();
    const ro = new ResizeObserver(doFit);
    ro.observe(el);
    xt.focus();

    return () => {
      ro.disconnect();
      onData.dispose();
      offOut();
      offExit();
      offTheme();
      xt.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host, termId]);

  return <div className="dash-xterm" ref={elRef} />;
}
