/**
 * IngestPanel — the Synapse ingest funnel.
 *
 * One glass card per channel input the local user can fire:
 *   - DOCUMENT  drag/drop or pick a file  → multipart POST /api/m/ingest/document
 *   - URL       paste a web link          → POST /api/m/ingest/url
 *   - YOUTUBE   paste a video link        → POST /api/m/ingest/youtube
 *   - SOCIAL    paste a post link or text → POST /api/m/ingest/social  (needs-review)
 *   - MEETING   paste a meeting note      → POST /api/m/ingest/meeting
 *
 * Every submit returns 202 {job_id}; the parent (SynapseModule) tracks the job
 * and follows its status over SSE. The web/social channels also land in the Axon
 * review queue server-side.
 *
 * Authored against atlas-api/src/routes/ingest.ts (the field names here —
 * file/title/url/text — are exactly what the server + extractors read).
 */
import { useRef, useState, type DragEvent, type JSX } from "react";
import {
  ingest,
  ingestFile,
  type Channel,
  type IngestAccepted,
} from "../../atlas/lib/api";
import {
  IconUpload,
  IconLink,
  IconYouTube,
  IconSocial,
  IconMeeting,
  IconSend,
} from "../../atlas/components/Icons";

interface IngestPanelProps {
  /** Called with the accepted job + a human label so the parent can follow it. */
  onAccepted: (job: IngestAccepted, label: string, channel: Channel) => void;
  onError: (message: string) => void;
}

export default function IngestPanel({ onAccepted, onError }: IngestPanelProps): JSX.Element {
  return (
    <div className="space-y-4">
      <div className="px-1">
        <span className="kicker" style={{ fontSize: "0.62rem", letterSpacing: "0.28em" }}>
          Ingest
        </span>
        <p className="mt-1 text-[0.8rem] text-ink-muted">
          Feed the funnel. Each submission becomes a durable job — extracted, embedded, and added to
          this workspace's knowledge.
        </p>
      </div>

      <DropCard onAccepted={onAccepted} onError={onError} />

      <LinkCard
        channel="url"
        title="Web page"
        placeholder="https://example.com/article"
        icon={<IconLink size={18} />}
        hint="Fetches and extracts the page's main content."
        onAccepted={onAccepted}
        onError={onError}
      />

      <LinkCard
        channel="youtube"
        title="YouTube"
        placeholder="https://youtube.com/watch?v=…"
        icon={<IconYouTube size={18} />}
        hint="Pulls the transcript and indexes the talk."
        onAccepted={onAccepted}
        onError={onError}
      />

      <TextCard
        channel="social"
        title="Social / paste"
        placeholder="Paste a post link or raw text…"
        icon={<IconSocial size={18} />}
        hint="Web & social land in the Axon review queue before they join the map."
        onAccepted={onAccepted}
        onError={onError}
      />

      <TextCard
        channel="meeting"
        title="Meeting note"
        placeholder="Paste meeting notes or a transcript…"
        icon={<IconMeeting size={18} />}
        hint="Captured as a meeting document in this workspace."
        onAccepted={onAccepted}
        onError={onError}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Document drop / upload
// ---------------------------------------------------------------------------

function DropCard({ onAccepted, onError }: IngestPanelProps): JSX.Element {
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const send = async (file: File): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await ingestFile("document", file, { title: file.name });
      onAccepted(res, file.name, "document");
    } catch (err) {
      onError(err instanceof Error ? err.message : "upload_failed");
    } finally {
      setBusy(false);
    }
  };

  const onDrop = (e: DragEvent<HTMLDivElement>): void => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void send(file);
  };

  return (
    <div className="glass p-4">
      <div className="mb-2 flex items-center gap-2 text-ink">
        <span className="text-violet-soft">
          <IconUpload size={18} />
        </span>
        <span className="text-[0.92rem] font-medium">Document</span>
      </div>
      <div
        className={`dropzone ${dragging ? "is-dragging" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onClick={() => inputRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            inputRef.current?.click();
          }
        }}
        style={{ cursor: "pointer" }}
      >
        <p className="text-[0.9rem] text-ink-muted">
          {busy ? "Uploading…" : "Drop a file here, or click to choose"}
        </p>
        <p className="mt-1 text-[0.72rem] text-ink-dim">PDF, DOCX, TXT, Markdown…</p>
        <input
          ref={inputRef}
          type="file"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void send(file);
            e.target.value = "";
          }}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Single-line link channels (url, youtube)
// ---------------------------------------------------------------------------

interface ChannelCardProps extends IngestPanelProps {
  channel: Channel;
  title: string;
  placeholder: string;
  icon: JSX.Element;
  hint: string;
}

function LinkCard({
  channel,
  title,
  placeholder,
  icon,
  hint,
  onAccepted,
  onError,
}: ChannelCardProps): JSX.Element {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    const url = value.trim();
    if (!url || busy) return;
    setBusy(true);
    try {
      const res = await ingest(channel, { url });
      onAccepted(res, url, channel);
      setValue("");
    } catch (err) {
      onError(err instanceof Error ? err.message : `${channel}_failed`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="glass p-4">
      <div className="mb-2 flex items-center gap-2 text-ink">
        <span className="text-violet-soft">{icon}</span>
        <span className="text-[0.92rem] font-medium">{title}</span>
      </div>
      <div className="flex items-center gap-2">
        <input
          className="field"
          value={value}
          placeholder={placeholder}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void submit();
            }
          }}
        />
        <button
          type="button"
          className="btn-ghost shrink-0"
          style={{ padding: "0.7rem 1rem" }}
          disabled={busy || !value.trim()}
          onClick={() => void submit()}
        >
          <IconSend size={16} />
          {busy ? "Sending" : "Add"}
        </button>
      </div>
      <p className="mt-2 text-[0.72rem] text-ink-dim">{hint}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Multi-line text channels (social, meeting)
// ---------------------------------------------------------------------------

function TextCard({
  channel,
  title,
  placeholder,
  icon,
  hint,
  onAccepted,
  onError,
}: ChannelCardProps): JSX.Element {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    const text = value.trim();
    if (!text || busy) return;
    setBusy(true);
    try {
      // social accepts url OR text; meeting requires text. A bare http(s) string
      // in the social box is treated as a link, otherwise as raw text.
      const isLink = /^https?:\/\//i.test(text);
      const payload: Record<string, unknown> =
        channel === "social" && isLink ? { url: text } : { text };
      const res = await ingest(channel, payload);
      onAccepted(res, text.slice(0, 60), channel);
      setValue("");
    } catch (err) {
      onError(err instanceof Error ? err.message : `${channel}_failed`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="glass p-4">
      <div className="mb-2 flex items-center gap-2 text-ink">
        <span className="text-violet-soft">{icon}</span>
        <span className="text-[0.92rem] font-medium">{title}</span>
      </div>
      <textarea
        className="field"
        rows={3}
        value={value}
        placeholder={placeholder}
        style={{ resize: "vertical", fontFamily: "var(--font-display)" }}
        onChange={(e) => setValue(e.target.value)}
      />
      <div className="mt-2 flex items-center justify-between">
        <p className="text-[0.72rem] text-ink-dim">{hint}</p>
        <button
          type="button"
          className="btn-ghost shrink-0"
          style={{ padding: "0.6rem 1rem" }}
          disabled={busy || !value.trim()}
          onClick={() => void submit()}
        >
          <IconSend size={16} />
          {busy ? "Sending" : "Add"}
        </button>
      </div>
    </div>
  );
}
