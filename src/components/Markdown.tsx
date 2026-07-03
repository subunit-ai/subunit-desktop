/**
 * Markdown.tsx — geteilter Markdown-Renderer für Assistenten-/Bot-Inhalte
 * (KI-Threads, Bot-Räume, U1-Orb).
 *
 * · GFM (Tabellen, Task-Listen, Strikethrough) via remark-gfm
 * · Code-Blöcke mit Sprach-Label + Kopieren-Button (kein Highlighting — bewusst
 *   schlank; ein Tokenizer kann später in CodeBlock andocken)
 * · Links öffnen extern (onLink → Rust open_external), nie in der WebView
 * · React-nativ gerendert (kein innerHTML) — kein Sanitizer nötig
 *
 * User-/Team-Nachrichten bleiben bewusst Plaintext (Telegram-Verhalten):
 * Markdown ist ein Assistenten-Ausgabeformat, keine Chat-Eingabe-Syntax.
 */
import { useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const CSS = `
.sumd{white-space:normal;word-break:break-word;line-height:1.55;min-width:0}
.sumd>:first-child{margin-top:0}
.sumd>:last-child{margin-bottom:0}
.sumd p{margin:0 0 8px}
.sumd ul,.sumd ol{margin:0 0 8px;padding-left:20px}
.sumd li{margin:2px 0}
.sumd li>p{margin:0}
.sumd h1,.sumd h2,.sumd h3,.sumd h4,.sumd h5,.sumd h6{margin:12px 0 6px;line-height:1.3;font-weight:650}
.sumd h1{font-size:1.15em}
.sumd h2{font-size:1.1em}
.sumd h3{font-size:1.05em}
.sumd h4,.sumd h5,.sumd h6{font-size:1em}
.sumd blockquote{margin:0 0 8px;padding:2px 12px;border-left:2px solid var(--cyan,#22d3ee);opacity:.85}
.sumd hr{border:none;border-top:1px solid var(--line,rgba(127,127,127,.25));margin:10px 0}
.sumd a{color:var(--cyan,#0891b2);text-decoration:none;border-bottom:1px solid transparent;cursor:pointer}
.sumd a:hover{border-bottom-color:currentColor}
.sumd code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.92em;background:var(--fill,rgba(127,127,127,.14));border:1px solid var(--line,rgba(127,127,127,.18));border-radius:5px;padding:1px 5px}
.sumd-cb{margin:0 0 8px;border:1px solid var(--line,rgba(127,127,127,.2));border-radius:10px;overflow:hidden;background:rgba(10,16,24,.05)}
html.dark .sumd-cb{background:rgba(0,0,0,.3)}
.sumd-cb-h{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:4px 10px;border-bottom:1px solid var(--line,rgba(127,127,127,.15));font-size:11px;opacity:.78}
.sumd-cb-l{text-transform:lowercase;letter-spacing:.04em;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.sumd-cb-c{display:inline-flex;align-items:center;gap:4px;background:none;border:none;color:inherit;cursor:pointer;font:inherit;font-size:11px;padding:2px 5px;border-radius:5px}
.sumd-cb-c:hover{background:var(--fill,rgba(127,127,127,.15))}
.sumd-cb-c svg{width:13px;height:13px}
.sumd-cb-sp{flex:1}
.sumd-cb-c.on{background:var(--fill,rgba(127,127,127,.15))}
.sumd-art{display:block;width:100%;height:320px;border:none;background:#fff;border-radius:0 0 9px 9px}
.sumd-cb pre{margin:0;padding:10px 12px;overflow-x:auto}
.sumd-cb pre code{background:none;border:none;padding:0;font-size:12.5px;line-height:1.5;white-space:pre}
.sumd-tbl{overflow-x:auto;margin:0 0 8px}
.sumd-tbl table{border-collapse:collapse;font-size:.95em}
.sumd-tbl th,.sumd-tbl td{border:1px solid var(--line,rgba(127,127,127,.25));padding:4px 9px;text-align:left}
.sumd-tbl th{background:var(--fill,rgba(127,127,127,.12));font-weight:600}
.sumd input[type=checkbox]{margin-right:6px;vertical-align:-1px}
`;

let cssInjected = false;
function ensureCss(): void {
  if (cssInjected || typeof document === "undefined") return;
  cssInjected = true;
  const el = document.createElement("style");
  el.id = "sumd-css";
  el.textContent = CSS;
  document.head.appendChild(el);
}

/** Flatten any React children tree to its raw text (for the copy button). */
function textOf(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (typeof node === "object" && "props" in node)
    return textOf((node.props as { children?: ReactNode }).children);
  return "";
}

/** Sprachen, die sich als Artefakt rendern lassen (sandboxed iframe, kein Netz/JS-Zugriff nach außen). */
const PREVIEWABLE = new Set(["html", "svg", "xml"]);

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const [preview, setPreview] = useState(false);
  const canPreview = PREVIEWABLE.has(lang) || (!lang && /^\s*<(!doctype|html|svg)/i.test(code));
  return (
    <div className="sumd-cb">
      <div className="sumd-cb-h">
        <span className="sumd-cb-l">{lang || "code"}</span>
        <span className="sumd-cb-sp" />
        {canPreview && (
          <button className={`sumd-cb-c${preview ? " on" : ""}`} title={preview ? "Code zeigen" : "Als Artefakt rendern (sandboxed)"} onClick={() => setPreview((v) => !v)}>
            {preview ? "Code" : "Vorschau"}
          </button>
        )}
        <button
          className="sumd-cb-c"
          title="Code kopieren"
          onClick={() => {
            navigator.clipboard
              ?.writeText(code)
              .then(() => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1400);
              })
              .catch(() => {});
          }}
        >
          {copied ? (
            "Kopiert"
          ) : (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <rect x="9" y="9" width="11" height="11" rx="2" />
              <path d="M5 15V5a2 2 0 0 1 2-2h10" />
            </svg>
          )}
        </button>
      </div>
      {preview && canPreview ? (
        // sandbox ohne allow-same-origin/allow-top-navigation: Scripts laufen isoliert,
        // kein Zugriff auf App-Origin, Storage oder die Tauri-Bridge.
        <iframe className="sumd-art" sandbox="allow-scripts" srcDoc={code} title="Artefakt-Vorschau" />
      ) : (
        <pre>
          <code>{code}</code>
        </pre>
      )}
    </div>
  );
}

export function Markdown({ text, onLink }: { text: string; onLink?: (url: string) => void }) {
  ensureCss();
  return (
    <div className="sumd">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a
              href={href}
              title={href}
              onClick={(e) => {
                e.preventDefault();
                if (href && /^https?:\/\//i.test(href)) onLink?.(href);
              }}
            >
              {children}
            </a>
          ),
          // Block-Code komplett selbst rendern (Label + Copy); der innere
          // <code> von react-markdown wird hier absichtlich nicht durchgereicht.
          pre: ({ children }) => {
            const child = (Array.isArray(children) ? children[0] : children) as ReactNode;
            let lang = "";
            let code = "";
            if (child && typeof child === "object" && "props" in child) {
              const props = child.props as { className?: string; children?: ReactNode };
              lang = /language-([\w+-]+)/.exec(props.className || "")?.[1] || "";
              code = textOf(props.children);
            } else {
              code = textOf(children);
            }
            return <CodeBlock lang={lang} code={code.replace(/\n$/, "")} />;
          },
          table: ({ children }) => (
            <div className="sumd-tbl">
              <table>{children}</table>
            </div>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
