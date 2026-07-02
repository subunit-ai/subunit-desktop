/**
 * chat/convo.tsx — shared building blocks of the Subunit Messenger (chat plugin).
 *
 * One bubble/composer/attachment layer used by all three conversation lanes
 * (bot rooms, team convos, KI threads) so the messenger feels like ONE app:
 *   · Bubble        — sender-aware message bubble: reply quote, attachments,
 *                     reactions, hover actions (react/reply/edit/delete/pin),
 *                     timestamp + edited mark + read receipt, search highlight
 *   · Composer      — textarea + attachment picker + voice recorder + reply/edit
 *                     bars; uploads run immediately (/api/uploads), send ships ids
 *   · AttachmentView— protected media via authenticated blob fetch (/api/media/:id)
 *   · DateSep       — Telegram-style day separators
 *
 * All styling lives in style.tsx (`.msn-*`), tokens from subunit-liquid-glass.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { HostApi } from "../../plugin/types";
import { Markdown } from "../../components/Markdown";
import {
  mediaObjectUrl,
  uploadFile,
  REACTION_SET,
  type AttachmentDTO,
  type ReactionDTO,
  type SendAttachment,
} from "../../lib/u1chat";

// ════════════════════════════════════════════════════════════════════════════
// Icons (SVG only — no emoji in chrome; reaction emojis are user content)
// ════════════════════════════════════════════════════════════════════════════

export const Svg = (props: { d: string; w?: number }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={props.w ?? 1.8}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    {props.d.split("|").map((p, i) => (
      <path key={i} d={p} />
    ))}
  </svg>
);

export const ICONS = {
  send: "M22 2 11 13|22 2l-7 20-4-9-9-4 20-7Z",
  plus: "M12 5v14M5 12h14",
  reply: "M9 17l-5-5 5-5|4 12h11a5 5 0 0 1 5 5v2",
  edit: "M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3Z",
  trash: "M3 6h18|8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2|19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6",
  pin: "M12 17v5|9 10.8 5.7 14a1 1 0 0 0 .7 1.7h11.2a1 1 0 0 0 .7-1.7L15 10.8V5l1-2H8l1 2v5.8Z",
  smile: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z|8 14s1.5 2 4 2 4-2 4-2|9 9h.01M15 9h.01",
  mic: "M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z|19 10v1a7 7 0 0 1-14 0v-1|12 18v4",
  stop: "M7 7h10v10H7Z",
  attach: "M21.4 11.05 12.25 20.2a6 6 0 0 1-8.49-8.49l9.2-9.19a4 4 0 0 1 5.65 5.66L9.4 17.4a2 2 0 0 1-2.83-2.83l8.49-8.48",
  x: "M18 6 6 18M6 6l12 12",
  search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z|21 21l-4.3-4.3",
  check: "M20 6 9 17l-5-5",
  checks: "M18 6 7 17l-4-4|M22 10l-7.5 7.5-2-2",
  dots: "M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z|19 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z|5 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z",
  download: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4|7 10l5 5 5-5|12 15V3",
  file: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z|14 2v6h6",
  group:
    "M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2|9 7m-4 0a4 4 0 1 0 8 0a4 4 0 1 0-8 0|23 21v-2a4 4 0 0 0-3-3.87|16 3.13a4 4 0 0 1 0 7.75",
  orb: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z|12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z",
  play: "M8 5v14l11-7Z",
};

// ════════════════════════════════════════════════════════════════════════════
// Small helpers
// ════════════════════════════════════════════════════════════════════════════

export function relTime(ts?: number | null): string {
  if (!ts) return "";
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return "jetzt";
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h`;
  return `${Math.floor(s / 86400)} d`;
}

export function clockTime(ts?: number): string {
  if (!ts) return "";
  return new Date(ts).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
}

export function dayLabel(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const yest = new Date(today.getTime() - 86400000);
  const same = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (same(d, today)) return "Heute";
  if (same(d, yest)) return "Gestern";
  return d.toLocaleDateString("de-DE", { day: "numeric", month: "long", year: "numeric" });
}

export function nameOf(email: string, name?: string): string {
  if (name && name.trim()) return name;
  const local = (email.split("@")[0] || "").replace(/[._-]+/g, " ").trim();
  return (
    local
      .split(" ")
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ") || email
  );
}

export const initialOf = (label: string): string => (label.trim().charAt(0) || "?").toUpperCase();

/** Map a thrown backend error to a friendly hint (401 → sign in). */
export function authHint(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/401|unauthorized/i.test(msg))
    return "Nicht angemeldet — melde dich oben rechts an, dann lädt der Chat.";
  return msg || "Etwas ist schiefgelaufen.";
}

/** Render `text` with all matches of `q` highlighted (in-convo search). */
export function Highlight({ text, q }: { text: string; q?: string }) {
  if (!q || !q.trim()) return <>{text}</>;
  const needle = q.trim().toLowerCase();
  const out: React.ReactNode[] = [];
  let rest = text;
  let i = 0;
  for (;;) {
    const at = rest.toLowerCase().indexOf(needle);
    if (at < 0) {
      out.push(rest);
      break;
    }
    if (at > 0) out.push(rest.slice(0, at));
    out.push(<mark key={i++}>{rest.slice(at, at + needle.length)}</mark>);
    rest = rest.slice(at + needle.length);
  }
  return <>{out}</>;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * A permanent client error (route missing on an un-migrated backend, or no
 * access) — reconnecting can never help, so the stream loop must stop instead
 * of hammering the endpoint every 1.5s forever.
 */
export function isPermanent(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /\b(401|403|404)\b|unauthorized|forbidden|not found/i.test(msg);
}

// ════════════════════════════════════════════════════════════════════════════
// Protected media
// ════════════════════════════════════════════════════════════════════════════

function useMediaUrl(host: HostApi, id?: string): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!id) return;
    let alive = true;
    mediaObjectUrl(host, id)
      .then((u) => alive && setUrl(u))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [host, id]);
  return url;
}

function fmtDuration(sec?: number): string {
  if (!sec || !isFinite(sec)) return "";
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function AttachmentView({ host, att }: { host: HostApi; att: AttachmentDTO }) {
  const url = useMediaUrl(host, att.id);
  if (att.kind === "image") {
    return url ? (
      <img className="msn-att-img" src={url} alt={att.name} loading="lazy" />
    ) : (
      <div className="msn-att-img msn-att-loading" />
    );
  }
  if (att.kind === "audio") {
    return (
      <div className="msn-att-audio">
        {url ? (
          <audio controls preload="metadata" src={url} />
        ) : (
          <span className="msn-att-load">Lädt…</span>
        )}
        {!!att.duration && <span className="msn-att-dur">{fmtDuration(att.duration)}</span>}
      </div>
    );
  }
  // Generic file chip → download via the (auth-fetched) object URL.
  return (
    <a
      className="msn-att-file"
      href={url ?? undefined}
      download={att.name}
      onClick={(e) => {
        if (!url) e.preventDefault();
      }}
      title={att.name}
    >
      <span className="msn-att-file-ic">
        <Svg d={ICONS.file} />
      </span>
      <span className="msn-att-file-n">{att.name}</span>
      <span className="msn-att-file-dl">
        <Svg d={ICONS.download} />
      </span>
    </a>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// Bubble
// ════════════════════════════════════════════════════════════════════════════

export interface BubbleActions {
  onReact?: (emoji: string) => void;
  onReply?: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
  onPin?: () => void;
}

export interface BubbleProps {
  host: HostApi;
  domId?: string;
  mine: boolean;
  /** Sender label above the bubble (group chats, theirs only). */
  senderLabel?: string;
  /** Small round avatar next to "theirs" bubbles (orb / initials). */
  avatar?: React.ReactNode;
  body: string;
  deleted?: boolean;
  edited?: boolean;
  streaming?: boolean;
  attachments?: AttachmentDTO[];
  reactions?: ReactionDTO[];
  replySender?: string;
  replyText?: string;
  time?: number;
  cost?: number;
  /** Read receipt: undefined = no receipt UI · false = sent · true = read. */
  read?: boolean;
  highlight?: string;
  /** Render body as Markdown (assistant/bot output). Off = Plaintext wie Telegram.
   *  Bei aktiver In-Convo-Suche fällt die Bubble auf Plaintext+Highlight zurück. */
  markdown?: boolean;
  actions?: BubbleActions;
}

export function Bubble(p: BubbleProps) {
  const [pickOpen, setPickOpen] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const a = p.actions;
  const hasActions = !!(a?.onReact || a?.onReply || a?.onEdit || a?.onDelete || a?.onPin);

  return (
    <div id={p.domId} className={`msn-msg ${p.mine ? "me" : "them"}`}>
      {p.avatar && <span className="msn-msg-av">{p.avatar}</span>}
      <div className="msn-msg-col">
        {p.senderLabel && <span className="msn-msg-sender">{p.senderLabel}</span>}
        <div className="msn-bubble-wrap">
          <div className="msn-bubble">
            {(p.replySender || p.replyText) && (
              <div className="msn-quote">
                <b>{p.replySender || ""}</b>
                <span>{p.replyText || ""}</span>
              </div>
            )}
            {!p.deleted &&
              p.attachments?.map((att) => <AttachmentView key={att.id} host={p.host} att={att} />)}
            {p.deleted ? (
              <i className="msn-deleted">Nachricht gelöscht</i>
            ) : p.body ? (
              p.markdown && !p.highlight?.trim() ? (
                <div className="msn-body md">
                  <Markdown text={p.body} onLink={(u) => p.host.ui.openExternal(u)} />
                </div>
              ) : (
                <span className="msn-body">
                  <Highlight text={p.body} q={p.highlight} />
                </span>
              )
            ) : p.streaming ? (
              <span className="msn-typing">
                <i />
                <i />
                <i />
              </span>
            ) : null}
            <span className="msn-meta">
              {p.edited ? <span className="msn-edited">bearbeitet</span> : null}
              {typeof p.cost === "number" && p.cost > 0 ? (
                <span className="msn-cost">{p.cost.toFixed(2)} $</span>
              ) : null}
              {p.time ? <span className="msn-time">{clockTime(p.time)}</span> : null}
              {p.mine && p.read !== undefined && (
                <span className={`msn-read${p.read ? " on" : ""}`}>
                  <Svg d={p.read ? ICONS.checks : ICONS.check} w={2.2} />
                </span>
              )}
            </span>
          </div>

          {hasActions && !p.deleted && (
            <div className="msn-acts">
              {a?.onReact && (
                <button className="msn-act" title="Reagieren" onClick={() => setPickOpen((o) => !o)}>
                  <Svg d={ICONS.smile} />
                </button>
              )}
              {a?.onReply && (
                <button
                  className="msn-act"
                  title="Antworten"
                  onClick={() => {
                    setPickOpen(false);
                    a.onReply!();
                  }}
                >
                  <Svg d={ICONS.reply} />
                </button>
              )}
              {a?.onPin && (
                <button className="msn-act" title="Anpinnen" onClick={() => a.onPin!()}>
                  <Svg d={ICONS.pin} />
                </button>
              )}
              {a?.onEdit && (
                <button className="msn-act" title="Bearbeiten" onClick={() => a.onEdit!()}>
                  <Svg d={ICONS.edit} />
                </button>
              )}
              {a?.onDelete &&
                (confirmDel ? (
                  <button
                    className="msn-act danger confirm"
                    title="Wirklich löschen"
                    onMouseLeave={() => setConfirmDel(false)}
                    onClick={() => {
                      setConfirmDel(false);
                      a.onDelete!();
                    }}
                  >
                    Löschen?
                  </button>
                ) : (
                  <button className="msn-act danger" title="Löschen" onClick={() => setConfirmDel(true)}>
                    <Svg d={ICONS.trash} />
                  </button>
                ))}
              {pickOpen && a?.onReact && (
                <div className="msn-pick" onMouseLeave={() => setPickOpen(false)}>
                  {REACTION_SET.map((e) => (
                    <button
                      key={e}
                      className="msn-pick-e"
                      onClick={() => {
                        setPickOpen(false);
                        a.onReact!(e);
                      }}
                    >
                      {e}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {!!p.reactions?.length && (
          <div className="msn-reacts">
            {p.reactions
              .filter((r) => r.count > 0)
              .map((r) => (
                <button
                  key={r.emoji}
                  className={`msn-react${r.mine ? " mine" : ""}`}
                  onClick={() => a?.onReact?.(r.emoji)}
                  title={r.mine ? "Reaktion entfernen" : "Auch reagieren"}
                >
                  {r.emoji}
                  {r.count > 1 && <span>{r.count}</span>}
                </button>
              ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function DateSep({ ts }: { ts: number }) {
  return (
    <div className="msn-datesep">
      <span>{dayLabel(ts)}</span>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// Voice recorder (MediaRecorder — Info.plist + entitlements are in place;
// degrades gracefully when WKWebView denies getUserMedia)
// ════════════════════════════════════════════════════════════════════════════

interface Recorder {
  stop(save: boolean): void;
}

async function startRecording(
  onDone: (blob: Blob, durationSec: number, ext: string) => void
): Promise<Recorder> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const mime = MediaRecorder.isTypeSupported("audio/mp4")
    ? "audio/mp4"
    : MediaRecorder.isTypeSupported("audio/webm")
      ? "audio/webm"
      : "";
  const mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const chunks: BlobPart[] = [];
  const started = Date.now();
  let save = false;
  mr.ondataavailable = (e) => {
    if (e.data.size) chunks.push(e.data);
  };
  mr.onstop = () => {
    stream.getTracks().forEach((t) => t.stop());
    if (save && chunks.length) {
      const type = mr.mimeType || mime || "audio/mp4";
      const ext = type.includes("webm") ? "webm" : type.includes("ogg") ? "ogg" : "m4a";
      onDone(new Blob(chunks, { type }), (Date.now() - started) / 1000, ext);
    }
  };
  mr.start(250);
  return {
    stop(s: boolean) {
      save = s;
      if (mr.state !== "inactive") mr.stop();
      else stream.getTracks().forEach((t) => t.stop());
    },
  };
}

// ════════════════════════════════════════════════════════════════════════════
// Composer
// ════════════════════════════════════════════════════════════════════════════

export interface ReplyTarget {
  id: number;
  sender: string;
  text: string;
}

export interface EditTarget {
  id: number;
  text: string;
}

interface PendingAtt {
  key: string;
  id?: string;
  kind: string;
  name: string;
  duration?: number;
  uploading: boolean;
  failed?: boolean;
}

export interface ComposerProps {
  host: HostApi;
  placeholder: string;
  disabled?: boolean;
  busy?: boolean;
  allowAttach?: boolean;
  allowVoice?: boolean;
  reply?: ReplyTarget | null;
  onCancelReply?: () => void;
  edit?: EditTarget | null;
  onCancelEdit?: () => void;
  /** Externally seeded draft (cockpit chat:seed); consumed once per change. */
  seed?: { text: string; n: number } | null;
  onTyping?: () => void;
  /** Resolve `false` to signal a failed send so the composer restores the draft. */
  onSend: (text: string, atts: SendAttachment[]) => boolean | void | Promise<boolean | void>;
}

let attKey = 0;

export function Composer(p: ComposerProps) {
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<PendingAtt[]>([]);
  const [recording, setRecording] = useState(false);
  const [recElapsed, setRecElapsed] = useState(0);
  const recRef = useRef<Recorder | null>(null);
  const recTimer = useRef<number | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const mountedRef = useRef(true);
  // Draft stashed when entering edit mode, restored verbatim on cancel.
  const preEditDraft = useRef("");
  const { host } = p;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Seed from the cockpit (chat:seed) — n bumps on every seed event.
  useEffect(() => {
    if (p.seed) {
      setDraft(p.seed.text);
      taRef.current?.focus();
    }
  }, [p.seed]);

  // Entering edit mode stashes the current draft + loads the message text; the
  // stash is restored by the cancel handler (Escape / ✕), not here.
  useEffect(() => {
    if (p.edit) {
      preEditDraft.current = draft;
      setDraft(p.edit.text);
      taRef.current?.focus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.edit?.id]);

  const cancelEdit = useCallback(() => {
    setDraft(preEditDraft.current);
    p.onCancelEdit?.();
  }, [p]);

  const upload = useCallback(
    async (file: File | Blob, kind: string, name: string, duration?: number) => {
      const key = `a${attKey++}`;
      setPending((prev) => [...prev, { key, kind, name, duration, uploading: true }]);
      try {
        const res = await uploadFile(host, file, kind, name);
        setPending((prev) =>
          prev.map((x) => (x.key === key ? { ...x, id: res.id, uploading: false } : x))
        );
      } catch {
        setPending((prev) =>
          prev.map((x) => (x.key === key ? { ...x, uploading: false, failed: true } : x))
        );
      }
    },
    [host]
  );

  const pickFiles = useCallback(
    (files: FileList | null) => {
      if (!files) return;
      for (const f of Array.from(files).slice(0, 10)) {
        const kind = f.type.startsWith("image/") ? "image" : f.type.startsWith("audio/") ? "audio" : "file";
        void upload(f, kind, f.name);
      }
    },
    [upload]
  );

  const startVoice = useCallback(async () => {
    if (recRef.current) return; // guard double-click while a recorder exists
    // Reserve the slot synchronously so a second click / unmount is detectable.
    recRef.current = { stop() {} };
    try {
      const rec = await startRecording((blob, dur, ext) => {
        void upload(blob, "audio", `sprachnachricht-${Date.now()}.${ext}`, Math.round(dur));
      });
      // Unmounted (convo switch) or superseded while the permission prompt was
      // open → immediately release the stream instead of leaking the mic.
      if (!mountedRef.current || recRef.current === null) {
        rec.stop(false);
        return;
      }
      recRef.current = rec;
      setRecording(true);
      setRecElapsed(0);
      recTimer.current = window.setInterval(() => setRecElapsed((s) => s + 1), 1000);
    } catch {
      recRef.current = null;
      host.notifications.notify("Mikrofon nicht verfügbar", "Sprachnachricht konnte nicht gestartet werden.");
    }
  }, [host, upload]);

  const stopVoice = useCallback((save: boolean) => {
    recRef.current?.stop(save);
    recRef.current = null;
    setRecording(false);
    if (recTimer.current) window.clearInterval(recTimer.current);
    recTimer.current = null;
  }, []);

  useEffect(
    () => () => {
      recRef.current?.stop(false);
      recRef.current = null;
      if (recTimer.current) window.clearInterval(recTimer.current);
    },
    []
  );

  const uploadsBusy = pending.some((x) => x.uploading);
  const ready = pending.filter((x) => x.id && !x.failed);
  const canSend = (draft.trim().length > 0 || ready.length > 0) && !uploadsBusy && !p.busy && !p.disabled;

  const doSend = useCallback(() => {
    if (!canSend) return;
    const text = draft.trim();
    const keptDraft = draft;
    const keptPending = pending;
    const atts: SendAttachment[] = ready.map((x) => ({
      id: x.id!,
      kind: x.kind,
      name: x.name,
      ...(x.duration ? { duration: x.duration } : {}),
    }));
    // Optimistically clear; restore verbatim if the send reports failure so the
    // typed text + uploaded attachments are never silently lost.
    setDraft("");
    setPending([]);
    void Promise.resolve(p.onSend(text, atts)).then((ok) => {
      if (ok === false && mountedRef.current) {
        setDraft((d) => (d ? d : keptDraft));
        setPending((cur) => (cur.length ? cur : keptPending));
      }
    });
  }, [canSend, draft, pending, ready, p]);

  return (
    <div className="msn-composer-wrap">
      {p.reply && (
        <div className="msn-bar">
          <span className="msn-bar-ic">
            <Svg d={ICONS.reply} />
          </span>
          <span className="msn-bar-tx">
            <b>{p.reply.sender}</b>
            <span>{p.reply.text}</span>
          </span>
          <button className="msn-bar-x" onClick={p.onCancelReply} title="Antwort verwerfen">
            <Svg d={ICONS.x} />
          </button>
        </div>
      )}
      {p.edit && (
        <div className="msn-bar edit">
          <span className="msn-bar-ic">
            <Svg d={ICONS.edit} />
          </span>
          <span className="msn-bar-tx">
            <b>Nachricht bearbeiten</b>
            <span>{p.edit.text}</span>
          </span>
          <button className="msn-bar-x" onClick={cancelEdit} title="Bearbeiten abbrechen">
            <Svg d={ICONS.x} />
          </button>
        </div>
      )}
      {pending.length > 0 && (
        <div className="msn-pending">
          {pending.map((x) => (
            <span key={x.key} className={`msn-chipatt${x.failed ? " failed" : ""}`}>
              {x.uploading ? <span className="msn-minispin" /> : <Svg d={x.kind === "audio" ? ICONS.mic : x.kind === "image" ? ICONS.file : ICONS.file} />}
              <span className="msn-chipatt-n">{x.failed ? `${x.name} — Upload fehlgeschlagen` : x.name}</span>
              <button
                className="msn-bar-x"
                onClick={() => setPending((prev) => prev.filter((y) => y.key !== x.key))}
                title="Entfernen"
              >
                <Svg d={ICONS.x} />
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="msn-composer">
        {p.allowAttach && (
          <>
            <input
              ref={fileRef}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                pickFiles(e.target.files);
                e.target.value = "";
              }}
            />
            <button
              className="msn-cbtn"
              title="Datei anhängen"
              disabled={p.disabled}
              onClick={() => fileRef.current?.click()}
            >
              <Svg d={ICONS.attach} />
            </button>
          </>
        )}

        {recording ? (
          <div className="msn-rec">
            <span className="msn-rec-dot" />
            <span className="msn-rec-t">{fmtDuration(recElapsed)}</span>
            <button className="msn-cbtn" title="Verwerfen" onClick={() => stopVoice(false)}>
              <Svg d={ICONS.x} />
            </button>
            <button className="msn-cbtn rec-stop" title="Aufnahme beenden & anhängen" onClick={() => stopVoice(true)}>
              <Svg d={ICONS.stop} />
            </button>
          </div>
        ) : (
          <textarea
            ref={taRef}
            className="fld msn-input"
            placeholder={p.placeholder}
            value={draft}
            disabled={p.disabled}
            onChange={(e) => {
              setDraft(e.target.value);
              p.onTyping?.();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                doSend();
              }
              if (e.key === "Escape") {
                if (p.edit) cancelEdit();
                else if (p.reply) p.onCancelReply?.();
              }
            }}
          />
        )}

        {p.allowVoice && !recording && !draft.trim() && pending.length === 0 ? (
          <button className="msn-cbtn" title="Sprachnachricht aufnehmen" disabled={p.disabled} onClick={() => void startVoice()}>
            <Svg d={ICONS.mic} />
          </button>
        ) : null}

        <button
          className="btn btn-primary minibtn msn-send"
          disabled={!canSend}
          onClick={doSend}
          title={p.edit ? "Änderung speichern (Enter)" : "Senden (Enter)"}
        >
          {p.busy ? <span className="msn-spin" /> : <Svg d={p.edit ? ICONS.check : ICONS.send} />}
        </button>
      </div>
    </div>
  );
}
