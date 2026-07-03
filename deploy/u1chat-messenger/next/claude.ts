// claude.ts — spawnt `claude -p` über den OAuth-Abo-Token (KEIN metered API).
// Ein kurzlebiger Prozess pro Nachricht → null Idle-Prozesse (RAM-clever).
// Agent-Arbeitsverzeichnis ist bewusst isoliert; AGENT_WORKDIR kann es konfigurieren.
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const PROJECT_ROOT = new URL("./", import.meta.url).pathname;
const AGENT_WORKDIR = resolve(process.env.AGENT_WORKDIR || join(PROJECT_ROOT, "agent-workspace"));
const BOT_TOKEN_FILE = "/home/subunit/.claude/.bot-token";
const CLIENT_ERROR = "Die Agent-Antwort konnte nicht erzeugt werden.";

// OAuth-Token einmal beim Start aus ~/.claude/.bot-token lesen (nie loggen).
function loadOAuthToken(): string {
  try {
    const raw = readFileSync(BOT_TOKEN_FILE, "utf8");
    const m = raw.match(/CLAUDE_CODE_OAUTH_TOKEN\s*=\s*["']?([^"'\s]+)/);
    return m?.[1] ?? "";
  } catch {
    return "";
  }
}
const OAUTH_TOKEN = loadOAuthToken();
if (!OAUTH_TOKEN) console.error("⚠️  Kein CLAUDE_CODE_OAUTH_TOKEN in .bot-token gefunden!");

function agentWorkdir(): string {
  mkdirSync(AGENT_WORKDIR, { recursive: true });
  return AGENT_WORKDIR;
}

// Kind-Env: API-Key RAUS (würde OAuth überschreiben), OAuth-Token REIN.
function childEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k === "ANTHROPIC_API_KEY") continue;
    if (v != null) env[k] = v;
  }
  env.CLAUDE_CODE_OAUTH_TOKEN = OAUTH_TOKEN;
  return env;
}

function redact(text: string): string {
  let out = text;
  if (OAUTH_TOKEN) out = out.split(OAUTH_TOKEN).join("[redacted-oauth-token]");
  return out
    .replace(/(CLAUDE_CODE_OAUTH_TOKEN\s*=\s*)["']?[^"'\s]+/g, "$1[redacted]")
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, "[redacted-token]")
    .replace(/[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g, "[redacted-jwt]");
}

export type StreamEvent =
  | { kind: "delta"; text: string }
  | { kind: "done"; text: string; sessionId?: string; cost?: number; error?: boolean }
  | { kind: "ratelimit"; info: any }
  | { kind: "error"; message: string };

// Streamt eine u1-Antwort. isNew → --session-id (anlegen), sonst --resume (fortsetzen).
export async function* streamClaude(
  sessionId: string,
  prompt: string,
  isNew: boolean,
  model = "sonnet",
  effort = "",
): AsyncGenerator<StreamEvent> {
  const args = [
    "-p",
    isNew ? "--session-id" : "--resume",
    sessionId,
    "--model",
    model,
    ...(effort ? ["--effort", effort] : []),
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--verbose",
    "--dangerously-skip-permissions",
  ];

  const proc = Bun.spawn(["claude", ...args], {
    cwd: agentWorkdir(),
    env: childEnv(),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  // Prompt über stdin (sicher gegenüber Sonderzeichen/Newlines/Emoji).
  proc.stdin!.write(prompt);
  await proc.stdin!.end();

  let buf = "";
  let finalText = "";
  let resultSeen = false;
  const decoder = new TextDecoder();

  for await (const chunk of proc.stdout as any) {
    buf += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let d: any;
      try {
        d = JSON.parse(line);
      } catch {
        continue;
      }
      if (d.type === "stream_event") {
        const ev = d.event;
        if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta") {
          finalText += ev.delta.text;
          yield { kind: "delta", text: ev.delta.text };
        }
      } else if (d.type === "rate_limit_event") {
        yield { kind: "ratelimit", info: d.rate_limit_info };
      } else if (d.type === "result") {
        resultSeen = true;
        const text = typeof d.result === "string" && d.result ? d.result : finalText;
        yield {
          kind: "done",
          text,
          sessionId: d.session_id,
          cost: d.total_cost_usd,
          error: d.is_error,
        };
      }
    }
  }

  const code = await proc.exited;
  if (!resultSeen) {
    const err = await new Response(proc.stderr as any).text();
    console.error("claude_failed", { code, stderr: redact(err).trim().slice(-2000) });
    yield {
      kind: "error",
      message: CLIENT_ERROR,
    };
  }
}

// ---- Auto-Titel + Auto-Farbe (selbst-organisierend) ----
const COLOR_MAP: Record<string, string> = {
  infra: "#ef4444",     // rot
  code: "#06b6d4",      // cyan
  content: "#a855f7",   // lila
  forge: "#f97316",     // orange
  revenue: "#22c55e",   // grün
  research: "#3b82f6",  // blau
  trading: "#f59e0b",   // amber
  misc: "#64748b",      // slate
};

// Einmaliger billiger Klassifizier-Lauf (sonnet, ohne Session) auf die erste Nachricht.
export async function classify(firstMsg: string): Promise<{ title: string; category: string; color: string }> {
  const cats = Object.keys(COLOR_MAP).join(", ");
  const prompt =
    `Klassifiziere diesen Chat-Start. Antworte NUR mit einer JSON-Zeile, kein Markdown:\n` +
    `{"title": "<max 4 Wörter, prägnant, deutsch>", "category": "<eine von: ${cats}>"}\n\n` +
    `Chat-Start: ${firstMsg.slice(0, 500)}`;

  const proc = Bun.spawn(
    ["claude", "-p", "--model", "sonnet", "--output-format", "json", "--dangerously-skip-permissions"],
    { cwd: agentWorkdir(), env: childEnv(), stdin: "pipe", stdout: "pipe", stderr: "ignore" },
  );
  proc.stdin!.write(prompt);
  await proc.stdin!.end();
  const out = await new Response(proc.stdout as any).text();
  await proc.exited;

  try {
    const outer = JSON.parse(out);
    const inner = JSON.parse(String(outer.result).match(/\{[\s\S]*\}/)?.[0] ?? "{}");
    const category = COLOR_MAP[inner.category] ? inner.category : "misc";
    const title = String(inner.title || "").trim().slice(0, 48) || "Neuer Chat";
    return { title, category, color: COLOR_MAP[category] };
  } catch {
    return { title: firstMsg.slice(0, 40), category: "misc", color: COLOR_MAP.misc };
  }
}
