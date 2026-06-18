/**
 * Dashboard — the flagship built-in plugin: a glass Ops board.
 *
 * LEFT/MAIN  : a Notion-synced TASK list (host.notion.listTasks) rendered as
 *              glass rows with status pills. Each row has two actions:
 *                · "Chat mit u1"     → host.nav.navigate("chat") + host.events.emit
 *                                       seeds the chat plugin with the task.
 *                · "Lokal ausführen" → host.terminals.spawn({ cmd:"claude",
 *                                       args:["-p", task.title], taskId }) and
 *                                       opens that terminal in the right pane.
 * RIGHT/PANEL: "Aktive Terminals" — host.terminals.list() live; each a glass row
 *              (title · task · running dot · output preview). Clicking opens an
 *              xterm-like terminal pane: host.terminals.onOutput streams into a
 *              .codebox, an input field writes back via host.terminals.write.
 *
 * Every surface is built from Subunit Liquid Glass classes + tokens only. The
 * desktop two-column layout + terminal pane sizing live in a scoped <style>
 * (plugin-root class `dash`), expressed entirely through design-system tokens —
 * no new palette, fonts, or glass recipe.
 *
 * Permissions: notion, terminals, events(ungated), nav(ungated), notifications,
 * storage.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import type {
  HostApi,
  NotionTask,
  PluginModule,
  TermInfo,
} from "../../plugin/types";

// Dock glyph — a control board (mirrors the original reference icon).
const ICON = `<svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="9" rx="2"/><rect x="14" y="3" width="7" height="5" rx="2"/><rect x="14" y="12" width="7" height="9" rx="2"/><rect x="3" y="16" width="7" height="5" rx="2"/></svg>`;

// Cross-plugin topic the Chat plugin subscribes to when seeded from a task.
const CHAT_SEED_TOPIC = "chat:seed";

// ── small inline icon helpers (design-system stroke conventions) ──────────────
const Svg = (props: { d: string; fill?: boolean }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.9}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    {props.d.split("|").map((p, i) => (
      <path key={i} d={p} fill={props.fill ? "currentColor" : "none"} />
    ))}
  </svg>
);

const ICONS = {
  chat: "M21 11.5a8.4 8.4 0 0 1-12 7.6L3 21l1.9-5.8A8.4 8.4 0 1 1 21 11.5Z",
  play: "M7 5l11 7-11 7V5Z",
  refresh: "M21 12a9 9 0 1 1-3-6.7|21 4v4h-4",
  terminal: "M5 7l5 5-5 5|13 17h6",
  task: "M9 11l3 3 8-8|21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11",
  send: "M22 2 11 13|22 2l-7 20-4-9-9-4 20-7Z",
  close: "M18 6 6 18|6 6l12 12",
  spark: "M12 3v6m0 6v6m9-9h-6M9 12H3|18.4 5.6l-4.2 4.2m-4.4 4.4-4.2 4.2",
} as const;

// ── status → pill class (design-system .pill live/wait/gone) ──────────────────
function statusPill(status?: string): { cls: string; label: string } {
  const s = (status ?? "").toLowerCase();
  if (/done|complete|fertig|erledigt|abgeschlossen/.test(s))
    return { cls: "live", label: status || "Done" };
  if (/progress|doing|läuft|in arbeit|active|wip/.test(s))
    return { cls: "wait", label: status || "In progress" };
  if (/block|wait|hold|paused|warten/.test(s))
    return { cls: "wait", label: status || "Blocked" };
  return { cls: "gone", label: status || "Backlog" };
}

// ════════════════════════════════════════════════════════════════════════════
// Terminal pane — xterm-like view for one pty.
// ════════════════════════════════════════════════════════════════════════════
function TerminalPane({
  host,
  term,
  onClose,
}: {
  host: HostApi;
  term: TermInfo;
  onClose: () => void;
}) {
  const [lines, setLines] = useState<string>("");
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(term.running);
  const bodyRef = useRef<HTMLDivElement>(null);

  // Stream output → codebox; track exit. Re-subscribes when the pty id changes.
  useEffect(() => {
    setLines("");
    setRunning(term.running);
    const offOut = host.terminals.onOutput(term.id, (chunk) =>
      setLines((prev) => (prev + chunk).slice(-20000))
    );
    const offExit = host.terminals.onExit(term.id, (code) => {
      setRunning(false);
      setLines((prev) => `${prev}\n\n[process exited with code ${code}]`);
    });
    return () => {
      offOut();
      offExit();
    };
  }, [host, term.id, term.running]);

  // Keep the codebox pinned to the newest output.
  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  const submit = useCallback(() => {
    const data = input;
    setInput("");
    void host.terminals.write(term.id, data + "\n");
  }, [host, input, term.id]);

  const kill = useCallback(() => {
    void host.terminals.kill(term.id);
  }, [host, term.id]);

  return (
    <div className="card dash-termpane">
      <div className="hd dash-termhd">
        <span className={`dash-dot ${running ? "on" : "off"}`} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <h1 className="dash-termtitle">{term.title}</h1>
          <p>
            {term.cmd}
            {term.taskId ? " · linked task" : ""} ·{" "}
            {running ? "running" : "exited"}
          </p>
        </div>
        {running && (
          <button className="btn btn-danger minibtn" onClick={kill}>
            Stop
          </button>
        )}
        <button className="iconbtn dash-x" onClick={onClose} title="Close pane">
          <span className="ic">
            <Svg d={ICONS.close} />
          </span>
        </button>
      </div>

      <div className="codebox dash-codebox" ref={bodyRef}>
        {lines ? (
          <pre className="dash-pre">{lines}</pre>
        ) : (
          <div className="dash-emptyterm">
            <span className="spinner" />
            Waiting for output…
          </div>
        )}
      </div>

      <div className="dash-terminput">
        <input
          className="fld dash-termfld"
          placeholder={running ? "Type and press Enter…" : "Process exited"}
          value={input}
          disabled={!running}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
        />
        <button
          className="btn btn-primary minibtn dash-termsend"
          disabled={!running}
          onClick={submit}
        >
          <Svg d={ICONS.send} />
        </button>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// Terminals panel (right column) — live list of ptys.
// ════════════════════════════════════════════════════════════════════════════
function TerminalsPanel({
  host,
  terms,
  refreshing,
  activeId,
  onOpen,
  onRefresh,
}: {
  host: HostApi;
  terms: TermInfo[];
  refreshing: boolean;
  activeId: string | null;
  onOpen: (t: TermInfo) => void;
  onRefresh: () => void;
}) {
  // Tiny live preview of the latest output line per terminal.
  const [previews, setPreviews] = useState<Record<string, string>>({});
  useEffect(() => {
    const offs = terms.map((t) =>
      host.terminals.onOutput(t.id, (chunk) => {
        const tail = chunk.split("\n").filter(Boolean).pop();
        if (tail)
          setPreviews((p) => ({ ...p, [t.id]: tail.replace(/\s+/g, " ").trim() }));
      })
    );
    return () => offs.forEach((o) => o());
  }, [host, terms]);

  return (
    <aside className="dash-panel">
      <div className="dash-panel-head">
        <div className="sect" style={{ margin: 0 }}>
          Aktive Terminals
        </div>
        <button
          className="iconbtn dash-mini"
          onClick={onRefresh}
          title="Refresh"
        >
          <span className={`ic ${refreshing ? "dash-spin" : ""}`}>
            <Svg d={ICONS.refresh} />
          </span>
        </button>
      </div>

      {terms.length === 0 ? (
        <div className="dash-panel-empty">
          <span className="ic">
            <Svg d={ICONS.terminal} />
          </span>
          <b>Keine laufenden Terminals</b>
          <span>
            Starte eine Aufgabe mit „Lokal ausführen“ — sie erscheint hier live.
          </span>
        </div>
      ) : (
        <ul className="list dash-termlist">
          {terms.map((t) => (
            <li
              key={t.id}
              className={`dash-termrow${t.id === activeId ? " is-active" : ""}`}
              onClick={() => onOpen(t)}
            >
              <span className={`dash-dot ${t.running ? "on" : "off"}`} />
              <div className="dash-termrow-tx">
                <div className="dash-termrow-title">{t.title}</div>
                <div className="dash-termrow-prev">
                  {previews[t.id] ||
                    (t.taskId ? "linked task" : t.cmd) ||
                    "—"}
                </div>
              </div>
              <span className={`pill ${t.running ? "live" : "gone"}`}>
                {t.running ? "Live" : "Done"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// Task list (main column)
// ════════════════════════════════════════════════════════════════════════════
function TaskList({
  tasks,
  loading,
  error,
  onChat,
  onRun,
  onRefresh,
  runningTaskIds,
}: {
  tasks: NotionTask[];
  loading: boolean;
  error: string | null;
  onChat: (t: NotionTask) => void;
  onRun: (t: NotionTask) => void;
  onRefresh: () => void;
  runningTaskIds: Set<string>;
}) {
  return (
    <section className="dash-main">
      <div className="dash-main-head">
        <div>
          <div className="ptitle">Aufgaben</div>
          <div className="psub">
            Notion-synchronisiert · an u1 delegieren oder lokal mit Claude
            ausführen.
          </div>
        </div>
        <button className="btn-ghost minibtn dash-refresh" onClick={onRefresh}>
          <span className={`dash-ic ${loading ? "dash-spin" : ""}`}>
            <Svg d={ICONS.refresh} />
          </span>
          Aktualisieren
        </button>
      </div>

      {error && <div className="callout dash-err">
        <Svg d="M12 9v4|M12 17h.01|M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
        <div>
          <b>Notion nicht erreichbar</b>
          <span>{error}</span>
        </div>
      </div>}

      {loading && tasks.length === 0 ? (
        <div className="dash-loading">
          <span className="spinner" />
          Lade Aufgaben…
        </div>
      ) : tasks.length === 0 && !error ? (
        <div className="card center dash-tasks-empty">
          <div className="dash-empty-ic">
            <Svg d={ICONS.task} />
          </div>
          <b>Keine offenen Aufgaben</b>
          <span className="hint center">
            Sobald in Notion Tasks anstehen, erscheinen sie hier als Glass-Reihen.
          </span>
        </div>
      ) : (
        <div className="dash-tasks">
          {tasks.map((t) => {
            const pill = statusPill(t.status);
            const running = runningTaskIds.has(t.id);
            return (
              <div className="dash-task" key={t.id}>
                <div className="dash-task-main">
                  <div className="dash-task-top">
                    <span className={`pill ${pill.cls}`}>{pill.label}</span>
                    {running && <span className="badge">läuft lokal</span>}
                  </div>
                  <div className="dash-task-title">{t.title || "Untitled"}</div>
                  {typeof t.assignee === "string" && t.assignee && (
                    <div className="dash-task-meta">{t.assignee}</div>
                  )}
                </div>
                <div className="dash-task-actions">
                  <button
                    className="btn-ghost minibtn dash-act"
                    onClick={() => onChat(t)}
                    title="Diese Aufgabe mit u1 besprechen"
                  >
                    <span className="dash-ic">
                      <Svg d={ICONS.chat} />
                    </span>
                    Chat mit u1
                  </button>
                  <button
                    className="btn btn-primary minibtn dash-act"
                    onClick={() => onRun(t)}
                    title="Lokal mit Claude ausführen"
                  >
                    <span className="dash-ic">
                      <Svg d={ICONS.play} />
                    </span>
                    Lokal ausführen
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// Dashboard view (composes main + panel + pane)
// ════════════════════════════════════════════════════════════════════════════
function DashboardView({ host }: { host: HostApi }) {
  const [tasks, setTasks] = useState<NotionTask[]>([]);
  const [tasksLoading, setTasksLoading] = useState(true);
  const [tasksError, setTasksError] = useState<string | null>(null);

  const [terms, setTerms] = useState<TermInfo[]>([]);
  const [termsRefreshing, setTermsRefreshing] = useState(false);
  const [activeTerm, setActiveTerm] = useState<TermInfo | null>(null);
  const [runningTaskIds, setRunningTaskIds] = useState<Set<string>>(new Set());

  // Local answer models (the downloaded ollama ones) used by "Lokal ausführen".
  const [runModels, setRunModels] = useState<{ id: string; label: string }[]>([]);
  const [runModel, setRunModel] = useState<string>("");

  // ── Notion tasks ──
  const loadTasks = useCallback(async () => {
    setTasksLoading(true);
    setTasksError(null);
    try {
      const list = await host.notion.listTasks();
      setTasks(list);
    } catch (err) {
      setTasksError(err instanceof Error ? err.message : String(err));
    } finally {
      setTasksLoading(false);
    }
  }, [host]);

  // ── Terminals ──
  const loadTerms = useCallback(async () => {
    setTermsRefreshing(true);
    try {
      const list = await host.terminals.list();
      setTerms(list);
      // Keep the active pane in sync (running flag may have flipped).
      setActiveTerm((cur) =>
        cur ? list.find((t) => t.id === cur.id) ?? cur : cur
      );
    } catch {
      /* terminals backend not present (browser) — leave empty */
    } finally {
      setTermsRefreshing(false);
    }
  }, [host]);

  // Load the LOCAL answer models (the downloaded ollama ones) for "Lokal ausführen".
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const saved = (await host.storage.get("dashboard.runModel")) as string | undefined;
        const res = await host.backend.fetch("atlas-api", "/api/m/models");
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as {
          models: { id: string; label: string; kind: string; available: boolean }[];
          default?: string;
        };
        const local = (data.models ?? [])
          .filter((m) => m.kind === "local" && m.available)
          .map((m) => ({ id: m.id, label: m.label }));
        setRunModels(local);
        const pick =
          saved && local.some((m) => m.id === saved)
            ? saved
            : data.default ?? local[0]?.id ?? "";
        setRunModel(pick);
      } catch {
        /* offline / no backend — "Lokal ausführen" falls back to a default model */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [host]);

  const selectRunModel = useCallback(
    (id: string) => {
      setRunModel(id);
      void host.storage.set("dashboard.runModel", id);
    },
    [host]
  );

  useEffect(() => {
    void loadTasks();
    void loadTerms();
    // Poll terminals so the panel stays live as ptys spawn/exit.
    const iv = window.setInterval(() => void loadTerms(), 2500);
    return () => window.clearInterval(iv);
  }, [loadTasks, loadTerms]);

  // ── Row actions ──
  const onChat = useCallback(
    (t: NotionTask) => {
      host.events.emit(CHAT_SEED_TOPIC, {
        taskId: t.id,
        title: t.title,
        status: t.status,
        url: t.url,
      });
      host.nav.navigate("chat");
    },
    [host]
  );

  const onRun = useCallback(
    async (t: NotionTask) => {
      // Argument-injection guard: a task title starting with "-" could be parsed as a
      // claude FLAG (e.g. an agent permission-bypass) instead of the prompt — and task
      // titles will come from Notion (external content). Refuse such titles, and pass
      // the prompt AFTER a "--" end-of-options separator so it's always positional.
      const prompt = (t.title ?? "").trim();
      if (!prompt || prompt.startsWith("-")) {
        host.notifications.notify(
          "Lokaler Start abgelehnt",
          "Unsicherer Aufgaben-Titel (leer oder beginnt mit „-“)."
        );
        return;
      }
      try {
        // Run the task on a LOCAL model (the downloaded ollama ones) — not the cloud.
        // `ollama run <model> <prompt>`: the prompt is positional, so the "-" guard
        // above (rejecting titles starting with "-") stops it being read as a flag.
        const llm = runModel || "qwen2.5:7b-instruct";
        const id = await host.terminals.spawn({
          cmd: "ollama",
          args: ["run", llm, prompt],
          taskId: t.id,
          title: t.title,
        });
        setRunningTaskIds((s) => new Set(s).add(t.id));
        host.notifications.notify("Lokal gestartet", `${llm} arbeitet an: ${t.title}`);
        await loadTerms();
        // Open the freshly spawned pty in the pane.
        const list = await host.terminals.list();
        const fresh = list.find((x) => x.id === id);
        if (fresh) setActiveTerm(fresh);
      } catch (err) {
        host.notifications.notify(
          "Start fehlgeschlagen",
          err instanceof Error ? err.message : String(err)
        );
      }
    },
    [host, loadTerms, runModel]
  );

  const openTerm = useCallback((t: TermInfo) => setActiveTerm(t), []);
  const closePane = useCallback(() => setActiveTerm(null), []);

  const activeTermId = activeTerm?.id ?? null;

  const headline = useMemo(() => {
    const live = terms.filter((t) => t.running).length;
    return live > 0 ? `${live} aktiv` : `${tasks.length} Aufgaben`;
  }, [terms, tasks.length]);

  return (
    <div className="dash">
      <DashStyle />

      <div className="dash-hero">
        <div className="dash-hero-tx">
          <h1>Ops Board</h1>
          <p>
            Notion-Aufgaben, an u1 delegierbar oder lokal mit Claude ausführbar —
            mit Live-Terminals direkt daneben.
          </p>
        </div>
        <span className="chip dash-hero-chip">
          <Svg d={ICONS.spark} />
          {headline}
        </span>
      </div>

      {runModels.length > 0 && (
        <div className="dash-runbar">
          <span className="dash-runbar-lbl">Lokal ausführen mit</span>
          {runModels.map((m) => (
            <button
              key={m.id}
              className={`chip dash-runchip${m.id === runModel ? " on" : ""}`}
              onClick={() => selectRunModel(m.id)}
              title={`Aufgaben lokal mit ${m.label} ausführen`}
            >
              {m.label}
            </button>
          ))}
        </div>
      )}

      <div className="dash-grid">
        <TaskList
          tasks={tasks}
          loading={tasksLoading}
          error={tasksError}
          onChat={onChat}
          onRun={onRun}
          onRefresh={loadTasks}
          runningTaskIds={runningTaskIds}
        />

        <div className="dash-rail">
          {activeTerm ? (
            <TerminalPane host={host} term={activeTerm} onClose={closePane} />
          ) : (
            <TerminalsPanel
              host={host}
              terms={terms}
              refreshing={termsRefreshing}
              activeId={activeTermId}
              onOpen={openTerm}
              onRefresh={loadTerms}
            />
          )}

          {/* When a pane is open, keep a compact terminal switcher beneath it. */}
          {activeTerm && terms.length > 1 && (
            <div className="dash-switcher">
              <div className="sect" style={{ margin: "0 0 8px" }}>
                Wechseln
              </div>
              <div className="dash-switcher-row">
                {terms.map((t) => (
                  <button
                    key={t.id}
                    className={`chip dash-switch-chip${
                      t.id === activeTermId ? " on" : ""
                    }`}
                    onClick={() => openTerm(t)}
                  >
                    <span className={`dash-dot ${t.running ? "on" : "off"}`} />
                    {t.title}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// Scoped layout — desktop two-column + terminal pane. Tokens ONLY.
// ════════════════════════════════════════════════════════════════════════════
function DashStyle() {
  return (
    <style>{`
.dash{width:100%;max-width:1200px;margin:0 auto;padding:26px 28px 56px}
.dash-hero{display:flex;align-items:flex-end;justify-content:space-between;gap:18px;margin:6px 2px 22px}
.dash-hero-tx h1{font-size:30px;font-weight:600;letter-spacing:-.035em;line-height:1.05}
.dash-hero-tx p{font-size:14.5px;color:var(--ink2);line-height:1.5;margin-top:8px;max-width:54ch;letter-spacing:-.006em}
.dash-hero-chip{cursor:default;gap:7px;padding:8px 14px;font-weight:600}
.dash-hero-chip svg{width:14px;height:14px;stroke:var(--cyan-d)}

.dash-runbar{display:flex;flex-wrap:wrap;align-items:center;gap:7px;margin:0 2px 16px}
.dash-runbar-lbl{font-size:11px;font-weight:650;letter-spacing:.05em;text-transform:uppercase;color:var(--ink3);margin-right:2px}
.dash-runchip{font-weight:550;color:var(--ink2)}
.dash-runchip.on{border-color:rgba(6,182,212,.4);color:var(--cyan-d);background:rgba(6,182,212,.08)}
.dash-grid{display:grid;grid-template-columns:minmax(0,1fr) 384px;gap:20px;align-items:start}
@media(max-width:980px){.dash-grid{grid-template-columns:1fr}}

/* ── main: tasks ── */
.dash-main{min-width:0}
.dash-main-head{display:flex;align-items:flex-end;justify-content:space-between;gap:14px;margin-bottom:16px}
.dash-refresh{display:inline-flex;align-items:center;gap:8px;width:auto}
.dash-ic{display:inline-flex;width:16px;height:16px}
.dash-ic svg,.dash-mini .ic svg,.dash-mini2 svg{width:16px;height:16px}
.dash-err{margin:0 0 16px}
.dash-tasks{display:flex;flex-direction:column;gap:12px}
.dash-task{display:flex;align-items:center;gap:16px;background:var(--glass);backdrop-filter:blur(34px) saturate(1.7);-webkit-backdrop-filter:blur(34px) saturate(1.7);border:1px solid var(--glass-edge);border-radius:var(--r-sm);box-shadow:var(--shadow-sm),inset 0 1px 0 var(--rim);padding:16px 18px;transition:transform .22s cubic-bezier(.2,.8,.2,1),box-shadow .22s}
.dash-task:hover{transform:translateY(-1px);box-shadow:var(--shadow),inset 0 1px 0 var(--rim)}
.dash-task-main{flex:1;min-width:0}
.dash-task-top{display:flex;align-items:center;gap:8px}
.dash-task-title{font-size:15.5px;font-weight:600;letter-spacing:-.012em;margin-top:8px;line-height:1.35}
.dash-task-meta{font-size:12.5px;color:var(--ink3);margin-top:4px}
.dash-task-actions{display:flex;gap:9px;flex:none}
.dash-act{display:inline-flex;align-items:center;gap:7px;width:auto;white-space:nowrap}
@media(max-width:640px){.dash-task{flex-direction:column;align-items:stretch}.dash-task-actions{justify-content:flex-end}}

.dash-loading,.dash-emptyterm{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;color:var(--ink2);font-size:13.5px;padding:48px 0}
.dash-tasks-empty{padding:40px 28px}
.dash-empty-ic,.dash-panel-empty .ic{width:46px;height:46px;border-radius:14px;display:grid;place-items:center;margin:0 auto 14px;background:linear-gradient(160deg,rgba(6,182,212,.16),rgba(6,182,212,.04));color:var(--cyan-d)}
.dash-empty-ic svg,.dash-panel-empty .ic svg{width:22px;height:22px}
.dash-tasks-empty b{display:block;font-size:16px;font-weight:600;color:var(--ink);margin-bottom:6px}

/* ── rail / panel ── */
.dash-rail{display:flex;flex-direction:column;gap:16px;position:sticky;top:8px}
.dash-panel{background:var(--glass);backdrop-filter:blur(34px) saturate(1.7);-webkit-backdrop-filter:blur(34px) saturate(1.7);border:1px solid var(--glass-edge);border-radius:var(--r);box-shadow:var(--shadow),inset 0 1px 0 var(--rim);padding:18px 18px 16px}
.dash-panel-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px}
.dash-mini{width:auto}
.dash-mini .ic{width:32px;height:32px;border-radius:10px}
.dash-panel-empty{text-align:center;padding:26px 14px 18px;color:var(--ink2)}
.dash-panel-empty b{display:block;font-size:14.5px;font-weight:600;color:var(--ink);margin-bottom:5px}
.dash-panel-empty span{font-size:12.5px;line-height:1.5;display:block;max-width:30ch;margin:0 auto}

.dash-termlist{margin-top:10px;gap:9px}
.dash-termrow{cursor:pointer;align-items:center;gap:11px;transition:transform .18s cubic-bezier(.2,.8,.2,1),border-color .18s,background .18s}
.dash-termrow:hover{transform:translateY(-1px);border-color:var(--line2)}
.dash-termrow.is-active{border-color:rgba(6,182,212,.4);background:rgba(6,182,212,.08)}
.dash-termrow-tx{flex:1;min-width:0}
.dash-termrow-title{font-size:14px;font-weight:600;letter-spacing:-.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dash-termrow-prev{font-size:11.5px;color:var(--ink3);font-family:ui-monospace,"SF Mono",Menlo,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:3px}

.dash-dot{width:8px;height:8px;border-radius:50%;flex:none}
.dash-dot.on{background:var(--ok);box-shadow:0 0 0 3px var(--ok-bg)}
.dash-dot.off{background:var(--ink3);opacity:.6}

/* ── terminal pane ── */
.dash-termpane{padding:16px 16px 14px;display:flex;flex-direction:column;gap:12px}
.dash-termhd{margin:0;align-items:center;gap:11px}
.dash-termtitle{font-size:16px;font-weight:600;letter-spacing:-.02em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dash-termhd p{font-size:11.5px;color:var(--ink3);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dash-x{width:auto}
.dash-x .ic{width:30px;height:30px;border-radius:9px}
.dash-x .ic svg{width:15px;height:15px}
.dash-codebox{text-align:left;margin:0;padding:14px 15px;height:340px;overflow:auto;background:var(--fill-focus);border-color:var(--line)}
html.dark .dash-codebox{background:rgba(2,8,18,.6)}
.dash-pre{font-family:ui-monospace,"SF Mono",Menlo,monospace;font-size:12.5px;line-height:1.55;color:var(--prose);white-space:pre-wrap;word-break:break-word;margin:0}
.dash-terminput{display:flex;gap:9px;align-items:center}
.dash-termfld{margin-top:0;font-family:ui-monospace,"SF Mono",Menlo,monospace;font-size:13px;padding:12px 14px}
.dash-termsend{width:auto;flex:none;padding:12px 14px}
.dash-termsend svg{width:17px;height:17px}

/* ── switcher beneath an open pane ── */
.dash-switcher{padding:0 2px}
.dash-switcher-row{display:flex;flex-wrap:wrap;gap:7px}
.dash-switch-chip{gap:7px}
.dash-switch-chip.on{border-color:rgba(6,182,212,.4);color:var(--cyan-d)}

.dash-spin{animation:dash-rot .9s linear infinite}
@keyframes dash-rot{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.dash-spin{animation:none}}
`}</style>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// Plugin module
// ════════════════════════════════════════════════════════════════════════════
let root: Root | null = null;
let offCmd: (() => void) | null = null;

const plugin: PluginModule = {
  manifest: {
    id: "dashboard",
    name: "Dashboard",
    version: "1.0.0",
    description:
      "Ops board — Notion tasks, delegate to u1 or run locally, live terminals.",
    icon: ICON,
    permissions: ["notion", "terminals", "notifications", "storage", "backend:atlas-api"],
    nav: { section: "ops", order: 0 },
    commands: [
      { id: "open", title: "Go to Ops Board" },
      { id: "refresh", title: "Dashboard: refresh tasks" },
    ],
  },
  mount(container, host) {
    root = createRoot(container);
    root.render(<DashboardView host={host} />);
    offCmd = host.events.on("command:dashboard:open", () =>
      host.nav.navigate("dashboard")
    );
  },
  unmount() {
    offCmd?.();
    offCmd = null;
    root?.unmount();
    root = null;
  },
};

export default plugin;
