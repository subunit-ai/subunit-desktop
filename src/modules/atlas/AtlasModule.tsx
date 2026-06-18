/**
 * AtlasModule — the three-pane cited-RAG knowledge console, mounted as a route in
 * the Subunit shell.
 *
 *   LEFT   workspace switcher (KnowledgeCompass) + document list
 *   CENTER chat thread (composer + streamed cited answer with [n] chips)
 *   RIGHT  sources panel (one glass card per citation)
 *
 * Ported from atlas-web/src/App.jsx. Differences from the standalone web app:
 *   - No LoginGate: the Subunit shell owns auth (echo-tauri loopback SSO). On
 *     mount we pull a fresh token via the shell IPC (`refreshToken`) and re-pull
 *     on `subunit://config-changed`. In local-dev bypass the token is empty and
 *     the sidecar accepts it.
 *   - It fills the shell `.surface` (no full-viewport takeover, no top sign-out
 *     bar — that lives in the shell chrome).
 *
 * This module owns the session token cache, the active workspace, the document
 * inventory, and the ask stream. Streaming deltas render live in the center;
 * citations + retrieved sources render on the right. Clicking a [n] chip
 * highlights the matching source card AND its document in the left list.
 */
import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import WorkspaceSwitcher from "./components/WorkspaceSwitcher";
import DocumentList from "./components/DocumentList";
import ChatThread, { type ChatMessage, type StreamingBuffer } from "./components/ChatThread";
import SourcesPanel from "./components/SourcesPanel";
import AtlasLogo from "./components/AtlasLogo";
import OrbitRing from "./components/OrbitRing";
import { listDocs, ask, openDoc, type Doc, type Citation, type RetrievedSource } from "./lib/api";
import {
  refreshToken,
  decodeToken,
  getWorkspaceIds,
  getActiveWorkspace,
  setActiveWorkspace,
} from "./lib/session";
import "./atlas.css";

let idSeq = 0;
const nextId = (): string => `m${Date.now()}-${idSeq++}`;

export default function AtlasModule(): JSX.Element {
  // The shell's ModuleHost primes `window.__ATLAS_TOKEN__` (and re-primes on
  // `config-changed`) before mounting us, so the token is already in place. We
  // still run one defensive `refreshToken()` so the module also works when it's
  // mounted outside that priming path (e.g. a plain dev tab).
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    refreshToken().finally(() => {
      if (!cancelled) setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!ready) {
    return (
      <div className="bg-universe relative grid h-full place-items-center">
        <OrbitRing size={34} label="Connecting your atlas…" />
      </div>
    );
  }

  return <Console />;
}

function Console(): JSX.Element {
  const claims = decodeToken();
  const workspaceIds = getWorkspaceIds();
  const [activeWs, setActiveWs] = useState<string | null>(getActiveWorkspace());

  // documents (left)
  const [docs, setDocs] = useState<Doc[]>([]);
  const [docsLoading, setDocsLoading] = useState(true);
  const [docsError, setDocsError] = useState<unknown>(null);

  // conversation (center)
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState<StreamingBuffer | null>(null);
  const [busy, setBusy] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);
  const [threadId, setThreadId] = useState<string | undefined>(undefined);
  const [draft, setDraft] = useState("");

  // cross-pane highlight
  const [activeCitation, setActiveCitation] = useState<number | null>(null);
  const [highlightDocId, setHighlightDocId] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  // --- load documents whenever the workspace changes ---
  const loadDocs = useCallback(async () => {
    setDocsLoading(true);
    setDocsError(null);
    try {
      const list = await listDocs({ limit: 200 });
      setDocs(list);
    } catch (err) {
      setDocsError(err);
    } finally {
      setDocsLoading(false);
    }
    // activeWs is read inside listDocs via the session; re-run on change.
  }, [activeWs]);

  useEffect(() => {
    loadDocs();
  }, [loadDocs]);

  // Switching workspace clears the conversation (new isolation boundary).
  const onSelectWorkspace = (id: string): void => {
    if (!id || id === activeWs) return;
    abortRef.current?.abort();
    setActiveWorkspace(id);
    setActiveWs(id);
    setMessages([]);
    setStreaming(null);
    setThreadId(undefined);
    setActiveCitation(null);
    setHighlightDocId(null);
    setAskError(null);
  };

  // --- ask: stream a cited answer ---
  const handleAsk = useCallback(
    async (query: string) => {
      if (busy) return;
      setAskError(null);
      setActiveCitation(null);
      setHighlightDocId(null);

      const userMsg: ChatMessage = { id: nextId(), role: "user", content: query };
      setMessages((m) => [...m, userMsg]);

      const controller = new AbortController();
      abortRef.current = controller;
      setBusy(true);
      setStreaming({ text: "", citations: [], sources: [], via: null, cloudBadge: null });

      try {
        const result = await ask(
          query,
          {
            onSources: (sources) =>
              setStreaming((s) => ({ ...(s ?? emptyStream()), sources })),
            onDelta: (_t, full) => setStreaming((s) => ({ ...(s ?? emptyStream()), text: full })),
            onCitations: (citations) =>
              setStreaming((s) => ({ ...(s ?? emptyStream()), citations })),
            onDone: (meta) =>
              setStreaming((s) => ({
                ...(s ?? emptyStream()),
                via: meta?.via ?? null,
                cloudBadge: meta?.cloud_badge ?? null,
              })),
            onError: (msg) => setAskError(friendlyError(msg)),
          },
          { threadId, nResults: 8, signal: controller.signal },
        );

        const assistantMsg: ChatMessage = {
          id: result.done?.message_id || nextId(),
          role: "assistant",
          text: result.text,
          citations: result.citations?.length
            ? result.citations
            : (result.sources as unknown as Citation[]),
          via: result.done?.via ?? null,
          cloudBadge: result.done?.cloud_badge ?? null,
          cost: result.done?.cost ?? null,
        };
        setMessages((m) => [...m, assistantMsg]);
        if (result.done?.thread_id) setThreadId(result.done.thread_id);
      } catch (err) {
        if (!controller.signal.aborted)
          setAskError(friendlyError(err instanceof Error ? err.message : undefined));
      } finally {
        setStreaming(null);
        setBusy(false);
        abortRef.current = null;
      }
    },
    [busy, threadId],
  );

  // The citation set the chips reference: live stream first, else last answer.
  const activeCitations: Citation[] = streaming?.citations?.length
    ? streaming.citations
    : lastAssistantCitations(messages);

  // --- citation chip click → highlight source card + matching document ---
  const focusCitation = (n: number, { scrollSource = true }: { scrollSource?: boolean } = {}): void => {
    setActiveCitation(n);
    const cite = activeCitations.find((c) => c.n === n);
    if (cite?.doc_id) {
      setHighlightDocId(cite.doc_id);
      requestAnimationFrame(() => {
        document
          .getElementById(`doc-card-${cite.doc_id}`)
          ?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      });
    }
    if (scrollSource) {
      requestAnimationFrame(() => {
        document
          .getElementById(`source-card-${n}`)
          ?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      });
    }
  };

  const onCite = (n: number): void => focusCitation(n, { scrollSource: true });
  const onActivateSource = (n: number): void => focusCitation(n, { scrollSource: false });

  const onOpenDoc = async (idOrDoc: string | Doc): Promise<void> => {
    const docId = typeof idOrDoc === "string" ? idOrDoc : idOrDoc?.doc_id;
    if (!docId) return;
    setHighlightDocId(docId);
    try {
      await openDoc(docId);
    } catch {
      /* opening the raw original is best-effort */
    }
  };

  // Right-pane data: live stream first, else the last assistant turn.
  const rightCitations: Citation[] = streaming
    ? streaming.citations
    : lastAssistantCitations(messages);
  const rightSources = (streaming?.sources ?? []) as RetrievedSource[];
  const rightVia = streaming ? streaming.via : lastAssistantField(messages, "via");
  const rightCloudBadge = streaming
    ? streaming.cloudBadge
    : lastAssistantField(messages, "cloudBadge");

  return (
    <div className="relative h-full overflow-hidden">
      {/* whole-surface deep-space ground */}
      <div className="bg-universe pointer-events-none absolute inset-0 -z-10" aria-hidden="true" />

      <div className="flex h-full flex-col">
        {/* module header */}
        <header className="flex shrink-0 items-center justify-between border-b border-line px-5 py-3 backdrop-blur-sm">
          <AtlasLogo size={30} withWordmark />
          {claims?.email && (
            <span className="hidden text-[0.78rem] text-ink-dim sm:inline">{claims.email}</span>
          )}
        </header>

        {/* three panes */}
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 p-4 lg:grid-cols-[300px_minmax(0,1fr)_360px]">
          <aside className="flex min-h-0 flex-col gap-4 overflow-hidden">
            <WorkspaceSwitcher
              workspaces={workspaceIds}
              activeId={activeWs}
              onSelect={onSelectWorkspace}
            />
            <DocumentList
              docs={docs}
              loading={docsLoading}
              error={docsError}
              highlightDocId={highlightDocId}
              onOpenDoc={onOpenDoc}
              onRetry={loadDocs}
            />
          </aside>

          <main className="flex min-h-0 flex-col overflow-hidden">
            <ChatThread
              messages={messages}
              streaming={streaming}
              busy={busy}
              activeCitation={activeCitation}
              error={askError}
              draft={draft}
              onDraftChange={setDraft}
              onSubmit={handleAsk}
              onCite={onCite}
            />
          </main>

          <aside className="hidden min-h-0 flex-col overflow-hidden lg:flex">
            <SourcesPanel
              citations={rightCitations}
              sources={rightSources}
              via={rightVia}
              cloudBadge={rightCloudBadge}
              loading={busy}
              activeN={activeCitation}
              onOpenDoc={onOpenDoc}
              onActivate={onActivateSource}
            />
          </aside>
        </div>
      </div>
    </div>
  );
}

function emptyStream(): StreamingBuffer {
  return { text: "", citations: [], sources: [], via: null, cloudBadge: null };
}

function lastAssistantCitations(messages: ChatMessage[]): Citation[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") return messages[i].citations || [];
  }
  return [];
}

function lastAssistantField(messages: ChatMessage[], field: "via" | "cloudBadge"): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") return messages[i][field] ?? null;
  }
  return null;
}

function friendlyError(msg?: string): string {
  if (!msg) return "Something went wrong. Please try again.";
  if (msg === "unauthorized") return "Your session expired. Please sign in again.";
  if (typeof msg === "string" && msg.startsWith("ask_failed_"))
    return "The answer service is unavailable right now.";
  return msg;
}
