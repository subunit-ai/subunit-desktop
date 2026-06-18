/**
 * ChatThread — the center pane.
 *
 * Renders the running conversation (user turns + streamed assistant answers with
 * inline [n] citation chips) and the composer with the signature violet
 * "Navigate" CTA. Streaming is owned by the parent (AtlasModule): it passes
 * `messages`, the live `streaming` buffer, and `onSubmit(query)`. Citation-chip
 * clicks bubble up via `onCite(n)` so the right + left panes can highlight.
 *
 * Ported from atlas-web/src/components/ChatThread.jsx.
 */
import { useEffect, useRef, useState, type JSX } from "react";
import CitationText from "./CitationText";
import OrbitRing from "./OrbitRing";
import EmptyState from "./EmptyState";
import { AtlasLogoMark } from "./AtlasLogo";
import { IconCompassStar } from "./Icons";
import type { Citation } from "../lib/api";

/** A committed conversation turn. */
export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content?: string; // user turns
  text?: string; // assistant turns
  citations?: Citation[];
  via?: string | null;
  cloudBadge?: string | null;
  cost?: number | null;
}

/** The live streaming buffer while an answer is in flight. */
export interface StreamingBuffer {
  text: string;
  citations: Citation[];
  sources: unknown[];
  via: string | null;
  cloudBadge: string | null;
}

interface ChatThreadProps {
  messages?: ChatMessage[];
  streaming?: StreamingBuffer | null;
  busy?: boolean;
  activeCitation?: number | null;
  error?: string | null;
  draft?: string;
  onDraftChange?: (v: string) => void;
  onSubmit?: (query: string) => void;
  onCite?: (n: number) => void;
}

export default function ChatThread({
  messages = [],
  streaming = null,
  busy = false,
  activeCitation = null,
  error = null,
  draft = "",
  onDraftChange,
  onSubmit,
  onCite,
}: ChatThreadProps): JSX.Element {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [internalDraft, setInternalDraft] = useState("");

  const value = onDraftChange ? draft : internalDraft;
  const setValue = onDraftChange || setInternalDraft;

  const hasConversation = messages.length > 0 || streaming;

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, streaming?.text]);

  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 220)}px`;
  }, [value]);

  const submit = (): void => {
    const q = value.trim();
    if (!q || busy) return;
    onSubmit?.(q);
    setValue("");
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {!hasConversation ? (
        <EmptyState onPick={(s) => setValue(s)} />
      ) : (
        <div ref={scrollRef} className="scroll-thin min-h-0 flex-1 overflow-y-auto px-1 py-2">
          <div className="mx-auto w-full max-w-3xl space-y-6">
            {messages.map((m) =>
              m.role === "user" ? (
                <UserTurn key={m.id} text={m.content ?? ""} />
              ) : (
                <AssistantTurn
                  key={m.id}
                  message={m}
                  activeCitation={activeCitation}
                  onCite={onCite}
                />
              ),
            )}

            {streaming && (
              <AssistantTurn
                streaming
                message={streaming}
                activeCitation={activeCitation}
                onCite={onCite}
              />
            )}

            {error && (
              <div className="mx-auto max-w-3xl rounded-xl border border-[rgba(255,90,120,0.4)] bg-[rgba(255,90,120,0.07)] px-4 py-3 text-sm text-[#ff9aa8]">
                {error}
              </div>
            )}
          </div>
        </div>
      )}

      <div className="mx-auto mt-3 w-full max-w-3xl shrink-0 px-1 pb-1">
        <div className="composer">
          <textarea
            ref={textareaRef}
            rows={1}
            value={value}
            placeholder="Ask your knowledge…"
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={onKeyDown}
            aria-label="Ask a question"
          />
          <button
            type="button"
            className="btn-violet shrink-0"
            disabled={busy || !value.trim()}
            onClick={submit}
            aria-label="Navigate"
          >
            {busy ? <OrbitRing size={18} label="" /> : <IconCompassStar size={16} />}
            <span>{busy ? "Navigating" : "Navigate"}</span>
          </button>
        </div>
        <p className="mt-2 px-1 text-center text-[0.7rem] text-ink-dim">
          Answers are grounded in this workspace and cite their sources.
        </p>
      </div>
    </div>
  );
}

function UserTurn({ text }: { text: string }): JSX.Element {
  return (
    <div className="flex justify-end">
      <div
        className="max-w-[85%] rounded-2xl px-4 py-2.5 text-[0.95rem] leading-relaxed text-ink"
        style={{
          background: "linear-gradient(180deg, rgba(124,58,237,0.22), rgba(124,58,237,0.12))",
          border: "1px solid rgba(167,139,255,0.32)",
        }}
      >
        {text}
      </div>
    </div>
  );
}

interface AssistantTurnProps {
  message: ChatMessage | StreamingBuffer;
  streaming?: boolean;
  activeCitation?: number | null;
  onCite?: (n: number) => void;
}

function AssistantTurn({
  message,
  streaming = false,
  activeCitation,
  onCite,
}: AssistantTurnProps): JSX.Element {
  const text = message.text ?? "";
  const citations = message.citations ?? [];
  const validNumbers = citations.length ? citations.map((c) => c.n) : undefined;
  const thinking = streaming && !text;

  return (
    <div className="flex gap-3">
      <span
        className="mt-1 shrink-0"
        style={{ filter: "drop-shadow(0 0 6px rgba(0,242,255,0.4))" }}
        aria-hidden="true"
      >
        <AtlasLogoMark size={26} twinkle={false} />
      </span>
      <div className="min-w-0 flex-1">
        {thinking ? (
          <div className="answer flex items-center" style={{ padding: "1rem 1.2rem" }}>
            <OrbitRing size={26} label="Searching your knowledge…" />
          </div>
        ) : (
          <div className={`answer ${streaming ? "stream-caret" : ""}`}>
            <CitationText
              text={text}
              validNumbers={validNumbers}
              activeN={activeCitation}
              onCite={onCite}
            />
          </div>
        )}
      </div>
    </div>
  );
}
