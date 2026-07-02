/**
 * Cockpit v4 — the live, orchestratable card board over every Claude Code
 * terminal on the Mac. A grid of round glass cards (one per session), not a flat
 * list, so the whole workspace is graspable at a glance and fully sortable,
 * filterable and groupable.
 *
 * Each CARD shows the hierarchy TJ wants — Projekt → Terminal → aktuelle Aufgabe —
 * plus live status, a user-set colour flag (priority), the per-session MODE
 * (Manuell / Notify / Autonom) and inline actions:
 *   · click the title / "Zum Terminal" → opens the REAL Terminal.app tab (focus
 *     the live tty, or open + `claude --resume`). The board is overview-only;
 *     the work happens in the real terminal.
 *   · "✦ U1"   → hands the session to the ubiquitous U1 assistant.
 *   · "Vorschau" → expands the card to stream that session's recent transcript.
 *
 * TOOLBAR: sort (Zuletzt aktiv / Projekt / Status / Markierung), status filter,
 * project filter, search, "nach Projekt gruppieren", the global Autonom master
 * and the C1 cloud orchestrator.
 *
 * ENGINE (unchanged from v3, proven): watches status transitions per mode —
 *   · Notify  → U1 pings you when a session starts waiting for input.
 *   · Autonom → U1 (Opus, via u1_ask) reads the session, writes the next prompt
 *               and sends it into the REAL terminal — only when the global
 *               Autonom master is on, rate-limited, capped and STOP-aware.
 *               (send_to_terminal itself refuses anything but a live claude tab.)
 */

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { isTauri } from "../../lib/ipc";
import type { ClaudeSession, HostApi, SessionTurn } from "../../plugin/types";

type TStatus = "working" | "waiting" | "idle" | "done";
const STAT: Record<TStatus, { label: string; cls: string }> = {
  working: { label: "Arbeitet", cls: "work" },
  waiting: { label: "Wartet auf dich", cls: "wait" },
  idle: { label: "Bereit", cls: "idle" },
  done: { label: "Fertig", cls: "done" },
};

type Mode = "manual" | "notify" | "auto";
const MODES: { id: Mode; label: string; hint: string }[] = [
  { id: "manual", label: "Manuell", hint: "Nur du steuerst diese Session" },
  { id: "notify", label: "Notify", hint: "U1 pingt dich, wenn die Session auf dich wartet" },
  { id: "auto", label: "Autonom", hint: "U1 schreibt + sendet selbst den nächsten Prompt (wenn Autonom global an)" },
];

// User-set colour flags (priority). Order = sort priority (urgent first).
type Flag = "urgent" | "important" | "active" | "watch" | "later";
const FLAGS: { id: Flag; label: string; color: string }[] = [
  { id: "urgent", label: "Dringend", color: "#ef4444" },
  { id: "important", label: "Wichtig", color: "#f59e0b" },
  { id: "active", label: "Aktiv", color: "#10b981" },
  { id: "watch", label: "Beobachten", color: "#3b82f6" },
  { id: "later", label: "Später", color: "#a855f7" },
];
const FLAG_ORDER: Record<Flag, number> = { urgent: 0, important: 1, active: 2, watch: 3, later: 4 };
const flagMeta = (f?: Flag) => FLAGS.find((x) => x.id === f);

type SortKey = "recent" | "project" | "status" | "flag";
const SORTS: { id: SortKey; label: string }[] = [
  { id: "recent", label: "Zuletzt aktiv" },
  { id: "project", label: "Projekt" },
  { id: "status", label: "Status" },
  { id: "flag", label: "Markierung" },
];
const STATUS_ORDER: Record<TStatus, number> = { waiting: 0, working: 1, idle: 2, done: 3 };

type StatusFilter = "all" | "waiting" | "working" | "quiet";

const MODE_KEY = "subunit.cockpit.modes";
const FLAG_KEY = "subunit.cockpit.flags";
const PREF_KEY = "subunit.cockpit.prefs";

const AUTO_SYSTEM =
  "Du bist U1 und hältst eine laufende Claude-Code-Session am Laufen. Die Session wartet auf den nächsten Input. " +
  "Gib AUSSCHLIESSLICH den nächsten Prompt zurück (1–2 Sätze), den ich an Claude senden soll, um sinnvoll voranzukommen — kein Markdown, keine Erklärung, kein Präfix. " +
  "Wenn die Aufgabe fertig wirkt, etwas unklar/riskant ist oder eine menschliche Entscheidung braucht, antworte EXAKT mit: STOP";

function relTime(ms: number): string {
  const d = Date.now() - ms;
  if (d < 45000) return "gerade eben";
  const m = Math.floor(d / 60000);
  if (m < 60) return `vor ${m} Min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `vor ${h} Std`;
  return `vor ${Math.floor(h / 24)} d`;
}
function askU1(question: string) {
  window.dispatchEvent(new CustomEvent("u1:ask", { detail: { question } }));
}
function loadJSON<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}
function saveJSON(key: string, val: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(val));
  } catch {
    /* ignore */
  }
}

interface Prefs {
  sort: SortKey;
  status: StatusFilter;
  project: string; // "" = all
  grouped: boolean;
}
const DEFAULT_PREFS: Prefs = { sort: "recent", status: "all", project: "", grouped: false };

export function Cockpit({
  host,
  sessions,
  refreshing,
  onRefresh,
  onResume,
  onC1,
}: {
  host: HostApi;
  sessions: ClaudeSession[];
  refreshing: boolean;
  onRefresh: () => void;
  onResume: (s: ClaudeSession) => void;
  onC1: () => void;
}) {
  const [modes, setModes] = useState<Record<string, Mode>>(() => loadJSON(MODE_KEY, {}));
  const [flags, setFlags] = useState<Record<string, Flag>>(() => loadJSON(FLAG_KEY, {}));
  const [prefs, setPrefs] = useState<Prefs>(() => ({ ...DEFAULT_PREFS, ...loadJSON(PREF_KEY, {}) }));
  const [query, setQuery] = useState("");
  // Autonom master is a SAFETY switch for real terminal control: it always cold-starts
  // OFF (never auto-reactivated from storage on launch) and requires an explicit confirm
  // to enable — see toggleMaster.
  const [master, setMaster] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [flagOpen, setFlagOpen] = useState<string | null>(null);
  const [transcripts, setTranscripts] = useState<Record<string, SessionTurn[]>>({});
  const [log, setLog] = useState<{ t: number; msg: string }[]>([]);

  const setPref = useCallback(<K extends keyof Prefs>(k: K, v: Prefs[K]) => {
    setPrefs((p) => {
      const n = { ...p, [k]: v };
      saveJSON(PREF_KEY, n);
      return n;
    });
  }, []);
  const setMode = useCallback((id: string, m: Mode) => {
    setModes((prev) => {
      const n = { ...prev, [id]: m };
      saveJSON(MODE_KEY, n);
      return n;
    });
  }, []);
  const setFlag = useCallback((id: string, f: Flag | null) => {
    setFlags((prev) => {
      const n = { ...prev };
      if (f) n[id] = f;
      else delete n[id];
      saveJSON(FLAG_KEY, n);
      return n;
    });
    setFlagOpen(null);
  }, []);
  // How many sessions U1 would actually drive when the master is on.
  const autoCount = useMemo(
    () => sessions.filter((s) => (modes[s.id] || "manual") === "auto").length,
    [sessions, modes]
  );
  const toggleMaster = useCallback(() => {
    if (master) {
      setMaster(false); // turning OFF is always immediate (the safe direction)
      return;
    }
    // Turning ON: confirm, because U1 will now send REAL prompts into live terminals.
    const ok = window.confirm(
      `Autonom global aktivieren?\n\nU1 (Opus) schreibt und sendet ab jetzt SELBST den nächsten Prompt in ${autoCount} auf „Autonom" gestellte Session${autoCount === 1 ? "" : "s"} — direkt in die echten Terminals, sobald sie auf dich warten.\n\nGedeckelt (Cooldown 25 s · max 4× in Folge · STOP-aware), jederzeit hier wieder abschaltbar. Beim App-Neustart ist Autonom immer wieder aus.`
    );
    if (ok) setMaster(true);
  }, [master, autoCount]);
  const toggleExpand = useCallback((id: string) => {
    setExpanded((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }, []);
  const addLog = useCallback((msg: string) => setLog((l) => [{ t: Date.now(), msg }, ...l].slice(0, 24)), []);

  // ── derived counts ──
  const working = sessions.filter((s) => s.status === "working").length;
  const waiting = sessions.filter((s) => s.status === "waiting").length;

  // Projects present (for the project filter), most-recent first.
  const projects = useMemo(() => {
    const seen = new Map<string, number>();
    for (const s of sessions) seen.set(s.projectName, Math.max(seen.get(s.projectName) ?? 0, s.lastActivity));
    return [...seen.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n);
  }, [sessions]);

  // ── filter + sort ──
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = sessions.filter((s) => {
      const st = (s.status as TStatus) ?? "idle";
      if (prefs.status === "waiting" && st !== "waiting") return false;
      if (prefs.status === "working" && st !== "working") return false;
      if (prefs.status === "quiet" && st !== "idle" && st !== "done") return false;
      if (prefs.project && s.projectName !== prefs.project) return false;
      if (q) {
        const hay = `${s.title} ${s.projectName} ${s.lastPrompt} ${s.projectPath}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    const byRecent = (a: ClaudeSession, b: ClaudeSession) => b.lastActivity - a.lastActivity;
    const cmp: Record<SortKey, (a: ClaudeSession, b: ClaudeSession) => number> = {
      recent: byRecent,
      project: (a, b) => a.projectName.localeCompare(b.projectName) || byRecent(a, b),
      status: (a, b) =>
        STATUS_ORDER[(a.status as TStatus) ?? "idle"] - STATUS_ORDER[(b.status as TStatus) ?? "idle"] || byRecent(a, b),
      flag: (a, b) =>
        (flags[a.id] ? FLAG_ORDER[flags[a.id]] : 9) - (flags[b.id] ? FLAG_ORDER[flags[b.id]] : 9) || byRecent(a, b),
    };
    return [...list].sort(cmp[prefs.sort]);
  }, [sessions, prefs, query, flags]);

  // Group the visible cards by project (preserve the sort within each group).
  const groups = useMemo(() => {
    if (!prefs.grouped) return null;
    const m = new Map<string, ClaudeSession[]>();
    for (const s of visible) {
      const arr = m.get(s.projectName) ?? [];
      arr.push(s);
      m.set(s.projectName, arr);
    }
    // Order project sections by their most-recent activity.
    return [...m.entries()].sort((a, b) => Math.max(...b[1].map((s) => s.lastActivity)) - Math.max(...a[1].map((s) => s.lastActivity)));
  }, [visible, prefs.grouped]);

  // ── poll transcripts for expanded cards only ──
  useEffect(() => {
    if (expanded.size === 0) return;
    let alive = true;
    const load = () => {
      for (const id of expanded) {
        host.terminals
          .sessionTranscript(id)
          .then((t) => alive && setTranscripts((prev) => ({ ...prev, [id]: t })))
          .catch(() => {});
      }
    };
    load();
    const iv = window.setInterval(load, 3000);
    return () => {
      alive = false;
      window.clearInterval(iv);
    };
  }, [host, expanded]);

  // ── engine: notify + autonomous handling on status transitions ──
  const prevStatus = useRef<Record<string, TStatus>>({});
  const notified = useRef<Set<string>>(new Set());
  const cooldown = useRef<Record<string, number>>({});
  const consec = useRef<Record<string, number>>({});
  const pending = useRef<Map<string, { id: string; tty: string; title: string }>>(new Map());
  const acc = useRef<Map<string, string>>(new Map());
  const modesRef = useRef(modes);
  modesRef.current = modes;
  const masterRef = useRef(master);
  masterRef.current = master;

  useEffect(() => {
    if (!isTauri()) return;
    const offs: UnlistenFn[] = [];
    let alive = true;
    const reg = (p: Promise<UnlistenFn>) => p.then((u) => (alive ? offs.push(u) : u()));
    reg(
      listen<{ requestId: string; text: string }>("u1://delta", (e) => {
        if (pending.current.has(e.payload.requestId))
          acc.current.set(e.payload.requestId, (acc.current.get(e.payload.requestId) || "") + e.payload.text);
      })
    );
    reg(
      listen<{ requestId: string }>("u1://done", (e) => {
        const p = pending.current.get(e.payload.requestId);
        if (!p) return;
        const text = (acc.current.get(e.payload.requestId) || "").trim();
        pending.current.delete(e.payload.requestId);
        acc.current.delete(e.payload.requestId);
        if (!text || /^stop\b/i.test(text)) {
          addLog(`Autonom: STOP für „${p.title}" — wartet jetzt auf dich`);
          host.notifications.notify("Autonom pausiert — dein Zug", p.title);
          return;
        }
        host.terminals
          .sendToTerminal(p.tty, text)
          .then(() => addLog(`Autonom → „${p.title}": ${text.slice(0, 90)}`))
          .catch((err) => addLog(`Autonom-Sendefehler („${p.title}"): ${err instanceof Error ? err.message : String(err)}`));
      })
    );
    reg(
      listen<{ requestId: string; message: string }>("u1://error", (e) => {
        const p = pending.current.get(e.payload.requestId);
        if (!p) return;
        pending.current.delete(e.payload.requestId);
        acc.current.delete(e.payload.requestId);
        addLog(`Autonom-Fehler („${p.title}"): ${e.payload.message}`);
      })
    );
    return () => {
      alive = false;
      offs.forEach((o) => o());
    };
  }, [host, addLog]);

  const triggerAuto = useCallback(
    async (s: ClaudeSession) => {
      if (!s.tty) return;
      cooldown.current[s.id] = Date.now() + 25000;
      consec.current[s.id] = (consec.current[s.id] || 0) + 1;
      addLog(`Autonom: U1 denkt für „${s.title}"…`);
      try {
        const trans = await host.terminals.sessionTranscript(s.id);
        const convo = trans
          .map((t) => `${t.role === "user" ? "Nutzer" : "Claude"}: ${t.text}`)
          .join("\n\n")
          .slice(-6000);
        const reqId = `auto${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
        pending.current.set(reqId, { id: s.id, tty: s.tty, title: s.title });
        acc.current.set(reqId, "");
        await invoke("u1_ask", {
          requestId: reqId,
          provider: "claude",
          model: "opus",
          messages: [
            { role: "system", content: AUTO_SYSTEM },
            { role: "user", content: `Session „${s.title}" (Projekt ${s.projectName}) wartet auf Input.\n\nVerlauf:\n${convo}\n\nNächster Prompt?` },
          ],
          cwd: s.cwdExists ? s.projectPath : undefined,
        });
      } catch (e) {
        addLog(`Autonom-Start fehlgeschlagen („${s.title}"): ${e instanceof Error ? e.message : String(e)}`);
      }
    },
    [host, addLog]
  );

  useEffect(() => {
    for (const s of sessions) {
      const prev = prevStatus.current[s.id];
      const mode = modesRef.current[s.id] || "manual";
      if (s.status === "waiting" && prev && prev !== "waiting") {
        if (mode === "notify" && !notified.current.has(s.id)) {
          notified.current.add(s.id);
          host.notifications.notify("U1: Session wartet auf dich", `${s.title} · ${s.projectName}`);
          addLog(`Notify: „${s.title}" wartet auf dich`);
        } else if (mode === "auto" && masterRef.current && s.tty) {
          const cnt = consec.current[s.id] || 0;
          if (Date.now() < (cooldown.current[s.id] || 0)) {
            /* cooling down */
          } else if (cnt >= 4) {
            host.notifications.notify("Autonom pausiert — bitte schauen", `${s.title}: 4× ohne dich`);
            addLog(`Autonom pausiert für „${s.title}" (4× in Folge) — bitte prüfen`);
          } else {
            void triggerAuto(s);
          }
        }
      }
      if (s.status === "working") notified.current.delete(s.id);
      prevStatus.current[s.id] = s.status as TStatus;
    }
  }, [sessions, host, addLog, triggerAuto]);

  // A user opening a session counts as human intervention → reset its auto counter.
  const openSession = useCallback(
    (s: ClaudeSession) => {
      consec.current[s.id] = 0;
      onResume(s);
    },
    [onResume]
  );

  const filtersOn = prefs.status !== "all" || !!prefs.project || query.trim() !== "";

  const renderCard = (s: ClaudeSession) => (
    <SessionCard
      key={s.id}
      s={s}
      mode={modes[s.id] || "manual"}
      flag={flags[s.id]}
      master={master}
      expanded={expanded.has(s.id)}
      turns={transcripts[s.id]}
      flagOpen={flagOpen === s.id}
      onOpen={() => openSession(s)}
      onU1={() =>
        askU1(
          `Zur Session „${s.title}" (${s.projectName}, Status ${STAT[(s.status as TStatus) ?? "idle"].label}): ${s.lastPrompt || "—"}. Was sollte ich als Nächstes tun?`
        )
      }
      onMode={(m) => setMode(s.id, m)}
      onFlag={(f) => setFlag(s.id, f)}
      onToggleFlagMenu={() => setFlagOpen((cur) => (cur === s.id ? null : s.id))}
      onToggleExpand={() => toggleExpand(s.id)}
    />
  );

  return (
    <section className="cb">
      <CockpitStyle />

      {/* ── header ── */}
      <div className="cb-head">
        <div className="cb-head-tx">
          <div className="cb-title">Arbeitsplatz</div>
          <div className="cb-sub">
            {sessions.length} Sessions · {working} arbeiten ·{" "}
            <span className={waiting ? "cb-sub-wait" : ""}>{waiting} warten auf dich</span>
          </div>
        </div>
        <div className="cb-head-r">
          <button
            className={`cb-master${master ? " on" : ""}`}
            onClick={toggleMaster}
            title={
              master
                ? `Autonom AN — U1 treibt ${autoCount} Session${autoCount === 1 ? "" : "s"} selbst. Klick zum Abschalten.`
                : "Globaler Schalter: lässt Autonom-Sessions selbst weiterarbeiten (fragt vor dem Aktivieren nach)"
            }
          >
            <span className="cb-master-dot" /> Autonom {master ? `AN${autoCount ? ` · ${autoCount}` : ""}` : "aus"}
          </button>
          {sessions.length > 0 && (
            <button className="cb-c1" onClick={onC1} title="C1: Cloud-Orchestrator über alle Sessions">
              <span className="cb-c1-badge">C1</span>
            </button>
          )}
          <button className="iconbtn cb-refresh" onClick={onRefresh} title="Aktualisieren">
            <span className={refreshing ? "cb-spin" : ""}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7" /><path d="M21 4v4h-4" /></svg>
            </span>
          </button>
        </div>
      </div>

      {/* ── toolbar: search · sort · filter · group ── */}
      {sessions.length > 0 && (
        <div className="cb-toolbar">
          <div className="cb-search">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></svg>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Sessions durchsuchen…"
              spellCheck={false}
            />
            {query && <button className="cb-search-x" onClick={() => setQuery("")} title="Leeren">×</button>}
          </div>

          <div className="cb-seg" role="group" aria-label="Filter Status">
            {([
              ["all", "Alle"],
              ["waiting", `Wartet${waiting ? ` ${waiting}` : ""}`],
              ["working", "Arbeitet"],
              ["quiet", "Ruhig"],
            ] as [StatusFilter, string][]).map(([id, label]) => (
              <button
                key={id}
                className={`cb-seg-b ${id}${prefs.status === id ? " on" : ""}`}
                onClick={() => setPref("status", id)}
              >
                {label}
              </button>
            ))}
          </div>

          {projects.length > 1 && (
            <select className="cb-select" value={prefs.project} onChange={(e) => setPref("project", e.target.value)} title="Projekt filtern">
              <option value="">Alle Projekte</option>
              {projects.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          )}

          <select className="cb-select" value={prefs.sort} onChange={(e) => setPref("sort", e.target.value as SortKey)} title="Sortieren">
            {SORTS.map((s) => (
              <option key={s.id} value={s.id}>Sortieren: {s.label}</option>
            ))}
          </select>

          <button
            className={`cb-group${prefs.grouped ? " on" : ""}`}
            onClick={() => setPref("grouped", !prefs.grouped)}
            title="Karten nach Projekt gruppieren"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round"><path d="M3 7h18M3 12h18M3 17h18" /></svg>
            Projekte
          </button>
        </div>
      )}

      {/* ── board ── */}
      {sessions.length === 0 ? (
        <div className="cb-empty">
          <b>Keine aktiven Claude-Sessions</b>
          <span>Sobald du irgendwo ein Terminal mit <code>claude</code> offen hast, erscheint es hier — live, als Karte.</span>
        </div>
      ) : visible.length === 0 ? (
        <div className="cb-empty">
          <b>Nichts passt zum Filter</b>
          <span>
            {filtersOn ? "Setz den Filter zurück, um wieder alle Sessions zu sehen." : "—"}
            {filtersOn && (
              <button className="cb-reset" onClick={() => { setPrefs((p) => ({ ...p, status: "all", project: "" })); saveJSON(PREF_KEY, { ...prefs, status: "all", project: "" }); setQuery(""); }}>Filter zurücksetzen</button>
            )}
          </span>
        </div>
      ) : groups ? (
        <div className="cb-grouped">
          {groups.map(([proj, list]) => (
            <div key={proj} className="cb-section">
              <div className="cb-section-h">
                <span className="cb-section-n">{proj}</span>
                <span className="cb-section-c">{list.length}</span>
                <span className="cb-section-path">{list[0]?.projectPath}</span>
              </div>
              <div className="cb-grid">{list.map(renderCard)}</div>
            </div>
          ))}
        </div>
      ) : (
        <div className="cb-grid">{visible.map(renderCard)}</div>
      )}

      {/* ── U1 activity strip ── */}
      {log.length > 0 && (
        <div className="cb-log">
          <span className="cb-log-h">U1-Aktivität</span>
          {log.slice(0, 3).map((l, i) => (
            <span key={i} className="cb-log-i">{l.msg}</span>
          ))}
        </div>
      )}
    </section>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// One session card.
// ════════════════════════════════════════════════════════════════════════════
function SessionCard({
  s,
  mode,
  flag,
  master,
  expanded,
  turns,
  flagOpen,
  onOpen,
  onU1,
  onMode,
  onFlag,
  onToggleFlagMenu,
  onToggleExpand,
}: {
  s: ClaudeSession;
  mode: Mode;
  flag?: Flag;
  master: boolean;
  expanded: boolean;
  turns?: SessionTurn[];
  flagOpen: boolean;
  onOpen: () => void;
  onU1: () => void;
  onMode: (m: Mode) => void;
  onFlag: (f: Flag | null) => void;
  onToggleFlagMenu: () => void;
  onToggleExpand: () => void;
}) {
  const st = STAT[(s.status as TStatus) ?? "idle"];
  const fm = flagMeta(flag);
  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (expanded && bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [turns, expanded]);
  const openTodos = s.todos?.filter((t) => t.status !== "completed") ?? [];
  const lastTurn = turns && turns.length ? turns[turns.length - 1] : undefined;

  return (
    <div className={`cb-card ${st.cls}${expanded ? " open" : ""}`} style={fm ? ({ "--flag": fm.color } as CSSProperties) : undefined}>
      {fm && <span className="cb-card-edge" />}

      <div className="cb-card-head">
        <span className={`cb-dot ${st.cls}`} />
        <span className={`cb-pill ${st.cls}`}>{st.label}</span>
        {s.live && <span className="cb-live">live</span>}
        <div style={{ flex: 1 }} />
        {mode !== "manual" && <span className={`cb-mb ${mode}`} title={mode === "auto" ? "Autonom" : "Notify"}>{mode === "auto" ? "A" : "N"}</span>}
        <div className="cb-flag-wrap">
          <button className="cb-flag-btn" onClick={onToggleFlagMenu} title="Markierung / Priorität">
            <span className="cb-flag-swatch" style={{ background: fm ? fm.color : "transparent", borderColor: fm ? fm.color : "var(--line2,var(--line))" }} />
          </button>
          {flagOpen && (
            <div className="cb-flag-menu" onMouseLeave={onToggleFlagMenu}>
              {FLAGS.map((f) => (
                <button key={f.id} className={`cb-flag-i${flag === f.id ? " on" : ""}`} onClick={() => onFlag(f.id)}>
                  <span className="cb-flag-swatch" style={{ background: f.color, borderColor: f.color }} /> {f.label}
                </button>
              ))}
              {flag && (
                <button className="cb-flag-i clear" onClick={() => onFlag(null)}>
                  <span className="cb-flag-swatch" style={{ borderColor: "var(--line2,var(--line))" }} /> Entfernen
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      <button className="cb-card-title" onClick={onOpen} title={s.tty ? "Echtes Terminal in den Vordergrund holen" : "Terminal öffnen + fortsetzen"}>
        {s.title || "Unbenannte Session"}
      </button>

      <div className="cb-card-meta">
        <span className="cb-proj" title={s.projectPath}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" /></svg>
          {s.projectName}
        </span>
        <span className="cb-sep">·</span>
        <span>{relTime(s.lastActivity)}</span>
        {!s.cwdExists && <span className="cb-warn" title="Arbeitsverzeichnis existiert nicht mehr">Ordner fehlt</span>}
        {openTodos.length > 0 && <span className="cb-todos" title={openTodos.map((t) => t.content).join("\n")}>{openTodos.length} To-do{openTodos.length > 1 ? "s" : ""}</span>}
      </div>

      {s.summary && !expanded && <div className="cb-card-prev">{s.summary}</div>}

      {expanded && (
        <div className="cb-convo" ref={bodyRef}>
          {!turns ? (
            <div className="cb-convo-empty"><span className="spinner" /> Lade Verlauf…</div>
          ) : turns.length === 0 ? (
            <div className="cb-convo-empty">Noch kein Verlauf sichtbar…</div>
          ) : (
            turns.map((t, i) => (
              <div key={i} className={`cb-turn ${t.role}`}>
                <span className="cb-turn-who">{t.role === "user" ? "Du" : "Claude"}</span>
                <div className="cb-turn-tx">{t.text}</div>
              </div>
            ))
          )}
          {s.status === "working" && lastTurn?.role === "user" && (
            <div className="cb-turn assistant"><span className="cb-turn-who">Claude</span><div className="cb-turn-tx cb-working"><span className="cb-typing"><i /><i /><i /></span> arbeitet…</div></div>
          )}
        </div>
      )}

      <div className="cb-card-foot">
        <button className="cb-act primary" onClick={onOpen}>{s.tty ? "Zum Terminal ↗" : "Öffnen ↗"}</button>
        <button className="cb-act" onClick={onU1}>✦ U1</button>
        <button className={`cb-act ghost${expanded ? " on" : ""}`} onClick={onToggleExpand} title="Live-Verlauf anzeigen">
          Vorschau {expanded ? "⌃" : "⌄"}
        </button>
      </div>

      <div className="cb-modes" role="group" aria-label="Modus">
        {MODES.map((m) => (
          <button key={m.id} className={`cb-mode${mode === m.id ? " on" : ""} ${m.id}`} title={m.hint} onClick={() => onMode(m.id)}>
            {m.label}
          </button>
        ))}
        {mode === "auto" && !master && <span className="cb-mode-hint" title="Der globale Autonom-Schalter oben ist aus">Schalter aus</span>}
      </div>
    </div>
  );
}

function CockpitStyle() {
  return (
    <style>{`
.cb{margin:0 2px 22px}
.cb-head{display:flex;align-items:flex-end;justify-content:space-between;gap:14px;margin-bottom:14px}
.cb-title{font-size:18px;font-weight:650;letter-spacing:-.02em}
.cb-sub{font-size:12.5px;color:var(--ink3);margin-top:4px}
.cb-sub-wait{color:#b7791f;font-weight:650}
.cb-head-r{display:flex;align-items:center;gap:8px;flex:none}
.cb-master{display:inline-flex;align-items:center;gap:7px;font:inherit;font-size:11.5px;font-weight:650;padding:5px 12px;border-radius:999px;border:1px solid var(--line);background:var(--glass2);color:var(--ink2);cursor:pointer;transition:.15s}
.cb-master-dot{width:7px;height:7px;border-radius:50%;background:var(--ink3)}
.cb-master.on{border-color:rgba(245,158,11,.5);background:rgba(245,158,11,.12);color:#b45309}
.cb-master.on .cb-master-dot{background:#f59e0b;animation:cb-beat 1.3s ease-out infinite}
.cb-c1{display:grid;place-items:center;height:30px;border-radius:999px;border:1px solid rgba(99,102,241,.35);background:rgba(99,102,241,.08);cursor:pointer;padding:0 6px}
.cb-c1-badge{display:grid;place-items:center;width:22px;height:22px;border-radius:7px;font-size:10px;font-weight:800;color:#fff;background:linear-gradient(160deg,#818cf8,#6366f1)}
.cb-refresh{width:auto}.cb-refresh span{display:grid;width:32px;height:32px;border-radius:10px;place-items:center}.cb-refresh svg{width:16px;height:16px}
.cb-spin{animation:cb-rot .9s linear infinite}@keyframes cb-rot{to{transform:rotate(360deg)}}

/* ── toolbar ── */
.cb-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-bottom:16px}
.cb-search{display:flex;align-items:center;gap:7px;flex:1;min-width:180px;max-width:320px;padding:7px 11px;border-radius:999px;border:1px solid var(--line);background:var(--glass2)}
.cb-search svg{width:15px;height:15px;color:var(--ink3);flex:none}
.cb-search input{flex:1;min-width:0;border:none;background:none;outline:none;font:inherit;font-size:12.5px;color:var(--ink)}
.cb-search input::placeholder{color:var(--ink3)}
.cb-search-x{flex:none;border:none;background:none;color:var(--ink3);font-size:17px;line-height:1;cursor:pointer;padding:0 2px}
.cb-search-x:hover{color:var(--ink)}
.cb-seg{display:flex;gap:2px;padding:2px;border-radius:999px;background:var(--fill-weak);border:1px solid var(--line)}
.cb-seg-b{font:inherit;font-size:11.5px;font-weight:650;padding:5px 11px;border-radius:999px;border:none;background:none;color:var(--ink3);cursor:pointer;white-space:nowrap;transition:.13s}
.cb-seg-b:hover{color:var(--ink)}
.cb-seg-b.on{background:var(--ink);color:var(--bg,#fff)}
.cb-seg-b.on.waiting{background:#f59e0b;color:#fff}
.cb-seg-b.on.working{background:#10b981;color:#fff}
.cb-select{font:inherit;font-size:11.5px;font-weight:600;padding:6px 10px;border-radius:999px;border:1px solid var(--line);background:var(--glass2);color:var(--ink2);cursor:pointer;max-width:190px}
.cb-group{display:inline-flex;align-items:center;gap:6px;font:inherit;font-size:11.5px;font-weight:650;padding:6px 12px;border-radius:999px;border:1px solid var(--line);background:var(--glass2);color:var(--ink2);cursor:pointer;transition:.15s}
.cb-group svg{width:14px;height:14px}
.cb-group:hover{color:var(--ink)}
.cb-group.on{border-color:rgba(6,182,212,.45);background:rgba(6,182,212,.1);color:var(--cyan-d,#0891b2)}

/* ── grid + sections ── */
.cb-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(312px,1fr));gap:14px}
.cb-grouped{display:flex;flex-direction:column;gap:22px}
.cb-section-h{display:flex;align-items:center;gap:9px;padding:0 2px 10px}
.cb-section-n{font-size:13px;font-weight:700;letter-spacing:.01em;color:var(--ink)}
.cb-section-c{display:grid;place-items:center;min-width:20px;height:20px;padding:0 6px;border-radius:999px;font-size:11px;font-weight:700;color:var(--ink2);background:var(--fill-weak);border:1px solid var(--line)}
.cb-section-path{font-size:11px;color:var(--ink3);font-family:ui-monospace,"SF Mono",Menlo,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

/* ── card ── */
.cb-card{position:relative;display:flex;flex-direction:column;gap:9px;padding:14px 15px 13px;border-radius:var(--r-sm);background:var(--glass);backdrop-filter:blur(30px) saturate(1.7);-webkit-backdrop-filter:blur(30px) saturate(1.7);border:1px solid var(--glass-edge);box-shadow:var(--shadow-sm),inset 0 1px 0 var(--rim);overflow:hidden;transition:transform .2s cubic-bezier(.2,.8,.2,1),box-shadow .2s,border-color .2s}
.cb-card:hover{transform:translateY(-2px);box-shadow:var(--shadow),inset 0 1px 0 var(--rim)}
.cb-card.wait{border-color:rgba(245,158,11,.4)}
.cb-card.open{grid-column:1/-1}
.cb-card-edge{position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--flag,transparent)}
.cb-card-head{display:flex;align-items:center;gap:7px}
.cb-dot{flex:none;width:9px;height:9px;border-radius:50%;background:var(--ink3)}
.cb-dot.work{background:#34d399;animation:cb-beat 1.6s ease-out infinite}
.cb-dot.wait{background:#fbbf24;animation:cb-beat 1.1s ease-out infinite}
.cb-dot.idle{background:#94a3b8}.cb-dot.done{background:var(--ink3);opacity:.55}
@keyframes cb-beat{0%{box-shadow:0 0 0 0 currentColor}70%{box-shadow:0 0 0 5px transparent}100%{box-shadow:0 0 0 0 transparent}}
.cb-pill{font-size:10.5px;font-weight:650;padding:1px 8px;border-radius:999px}
.cb-pill.work{color:#0a9d63;background:rgba(16,185,129,.12)}
.cb-pill.wait{color:#b7791f;background:rgba(251,191,36,.16)}
.cb-pill.idle,.cb-pill.done{color:var(--ink3);background:var(--glass2)}
.cb-live{font-size:9px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:#0a9d63;background:rgba(16,185,129,.13);border:1px solid rgba(16,185,129,.3);border-radius:5px;padding:1px 5px}
.cb-mb{flex:none;width:18px;height:18px;border-radius:6px;display:grid;place-items:center;font-size:10px;font-weight:800;color:#fff}
.cb-mb.notify{background:#06b6d4}.cb-mb.auto{background:#f59e0b}
.cb-flag-wrap{position:relative;flex:none}
.cb-flag-btn{display:grid;place-items:center;width:24px;height:24px;border-radius:7px;border:none;background:none;cursor:pointer}
.cb-flag-btn:hover{background:var(--fill-weak)}
.cb-flag-swatch{width:13px;height:13px;border-radius:50%;border:2px solid;box-sizing:border-box}
.cb-flag-menu{position:absolute;top:calc(100% + 5px);right:0;z-index:30;width:168px;padding:5px;border-radius:var(--r-sm);border:1px solid var(--glass-edge2,var(--glass-edge));background:var(--menu-bg,var(--glass));backdrop-filter:blur(34px) saturate(1.7);-webkit-backdrop-filter:blur(34px) saturate(1.7);box-shadow:var(--shadow),inset 0 1px 0 var(--rim)}
.cb-flag-i{display:flex;align-items:center;gap:9px;width:100%;text-align:left;padding:7px 8px;border:none;background:none;border-radius:8px;cursor:pointer;font:inherit;font-size:12.5px;color:var(--ink)}
.cb-flag-i:hover{background:var(--fill-weak)}
.cb-flag-i.on{background:var(--fill-weak);font-weight:650}
.cb-flag-i.clear{color:var(--ink3);border-top:1px solid var(--line);margin-top:3px;padding-top:8px}

.cb-card-title{text-align:left;font:inherit;font-size:14.5px;font-weight:650;letter-spacing:-.012em;line-height:1.32;color:var(--ink);background:none;border:none;cursor:pointer;padding:0;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.cb-card-title:hover{color:var(--cyan-d,#0891b2)}
.cb-card-meta{display:flex;align-items:center;flex-wrap:wrap;gap:6px;font-size:11.5px;color:var(--ink3)}
.cb-proj{display:inline-flex;align-items:center;gap:5px;max-width:160px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--ink2);font-weight:600}
.cb-proj svg{width:13px;height:13px;flex:none;color:var(--ink3)}
.cb-sep{opacity:.5}
.cb-warn{color:#b45309;font-weight:600}
.cb-todos{color:var(--cyan-d,#0891b2);font-weight:650;background:rgba(6,182,212,.08);border:1px solid rgba(6,182,212,.2);border-radius:6px;padding:0 6px}
.cb-card-prev{font-size:12px;line-height:1.5;color:var(--ink3);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;border-left:2px solid var(--line);padding-left:9px}

/* ── inline transcript (expanded) ── */
.cb-convo{max-height:300px;overflow-y:auto;display:flex;flex-direction:column;gap:10px;padding:10px 11px;border-radius:11px;background:var(--fill-weak);border:1px solid var(--line)}
.cb-convo-empty{display:flex;align-items:center;gap:8px;color:var(--ink3);font-size:12px;padding:14px;justify-content:center}
.cb-turn{display:flex;flex-direction:column;gap:3px;max-width:94%}
.cb-turn.user{align-self:flex-end;align-items:flex-end}
.cb-turn-who{font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--ink3)}
.cb-turn-tx{font-size:12.5px;line-height:1.5;padding:7px 11px;border-radius:11px;white-space:pre-wrap;word-break:break-word;max-height:200px;overflow:hidden}
.cb-turn.user .cb-turn-tx{background:linear-gradient(160deg,#22d3ee,#06b6d4);color:#fff;border-bottom-right-radius:4px}
.cb-turn.assistant .cb-turn-tx{background:var(--glass2);border:1px solid var(--line);color:var(--ink);border-bottom-left-radius:4px}
.cb-working{display:flex;align-items:center;gap:8px;color:var(--ink2)}
.cb-typing{display:inline-flex;gap:4px}.cb-typing i{width:5px;height:5px;border-radius:50%;background:var(--ink3);animation:cb-bounce 1.2s ease-in-out infinite}
.cb-typing i:nth-child(2){animation-delay:.15s}.cb-typing i:nth-child(3){animation-delay:.3s}
@keyframes cb-bounce{0%,80%,100%{transform:translateY(0);opacity:.4}40%{transform:translateY(-3px);opacity:1}}

/* ── card footer + modes ── */
.cb-card-foot{display:flex;align-items:center;gap:7px;margin-top:1px}
.cb-act{font:inherit;font-size:11.5px;font-weight:600;padding:6px 11px;border-radius:999px;border:1px solid var(--line);background:var(--glass2);color:var(--ink2);cursor:pointer;white-space:nowrap;transition:.14s}
.cb-act:hover{color:var(--ink);border-color:var(--line2,var(--line))}
.cb-act.primary{border-color:rgba(6,182,212,.32);background:rgba(6,182,212,.08);color:var(--cyan-d,#0891b2);font-weight:650}
.cb-act.primary:hover{background:rgba(6,182,212,.15)}
.cb-act.ghost{margin-left:auto;border-color:transparent;background:none;color:var(--ink3)}
.cb-act.ghost:hover,.cb-act.ghost.on{color:var(--cyan-d,#0891b2)}
.cb-modes{display:flex;align-items:center;gap:2px;padding:2px;border-radius:999px;background:var(--fill-weak);border:1px solid var(--line)}
.cb-mode{flex:1;font:inherit;font-size:10.5px;font-weight:650;padding:4px 6px;border-radius:999px;border:none;background:none;color:var(--ink3);cursor:pointer;white-space:nowrap;transition:.13s}
.cb-mode:hover{color:var(--ink)}
.cb-mode.on.manual{background:var(--ink);color:var(--bg,#fff)}
.cb-mode.on.notify{background:#06b6d4;color:#fff}
.cb-mode.on.auto{background:#f59e0b;color:#fff}
.cb-mode-hint{flex:none;font-size:9.5px;color:#b45309;padding:0 6px}

/* ── empty + log ── */
.cb-empty{text-align:center;padding:40px 18px;color:var(--ink2);border-radius:var(--r-sm);background:var(--glass);border:1px solid var(--glass-edge)}
.cb-empty b{display:block;font-size:15px;color:var(--ink);margin-bottom:6px}
.cb-empty span{font-size:12.5px}.cb-empty code{font-family:ui-monospace,Menlo,monospace;font-size:11.5px;background:var(--glass2);padding:1px 5px;border-radius:5px}
.cb-reset{display:block;margin:12px auto 0;font:inherit;font-size:12px;font-weight:600;padding:6px 14px;border-radius:999px;border:1px solid var(--line);background:var(--glass2);color:var(--ink);cursor:pointer}
.cb-log{display:flex;align-items:center;gap:10px;margin-top:14px;padding:9px 13px;border-radius:11px;background:rgba(99,102,241,.06);border:1px solid rgba(99,102,241,.18);overflow:hidden}
.cb-log-h{flex:none;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:#6366f1}
.cb-log-i{font-size:11.5px;color:var(--ink2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;border-left:1px solid var(--line);padding-left:10px}
@media (prefers-reduced-motion:reduce){.cb-dot,.cb-master.on .cb-master-dot,.cb-typing i,.cb-spin{animation:none}}
`}</style>
  );
}
