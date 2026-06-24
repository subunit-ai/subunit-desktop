/**
 * E-Mail — the Postfach: read, manage and act on email inside Subunit.
 *
 * A 3-pane mail client (folders · message list · reader) over u1@subunit.ai, with
 * U1 woven in: "Zusammenfassen" / "Antwort entwerfen" hand the message to the
 * ubiquitous U1 assistant (which already has system access). Incoming mail is
 * already ingested to u1 server-side (the S-03 Email-Ingest reflex); this is the
 * human-facing inbox on top.
 *
 * BACKEND (to wire once the email-api ships — IMAP read + SMTP send, Bearer-auth
 * like u1-chat, NOT behind Cloudflare Access):
 *   GET  /api/email/folders                       → Folder[]
 *   GET  /api/email/messages?folder=<id>          → MailSummary[]
 *   GET  /api/email/messages/:id                  → Mail (full body)
 *   POST /api/email/messages/:id/{read,star,archive,delete}
 *   POST /api/email/send  { to, subject, body }
 * Until then this runs on representative mock data so the UI is complete + demoable.
 *
 * Permissions: notifications. nav + ui + events are ungated.
 */

import { useMemo, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { HostApi, PluginModule } from "../../plugin/types";

const ICON = `<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/></svg>`;

const Svg = (p: { d: string }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
    {p.d.split("|").map((d, i) => <path key={i} d={d} />)}
  </svg>
);

type FolderId = "inbox" | "starred" | "sent" | "drafts" | "archive";

interface Folder { id: FolderId; name: string; icon: string }
const FOLDERS: Folder[] = [
  { id: "inbox", name: "Posteingang", icon: "M3 5h18v14H3z|m3 7 9 6 9-6" },
  { id: "starred", name: "Wichtig", icon: "M12 3l2.9 6 6.6.5-5 4.3 1.6 6.4L12 17l-6.1 3.7 1.6-6.4-5-4.3 6.6-.5z" },
  { id: "sent", name: "Gesendet", icon: "M22 2 11 13|22 2l-7 20-4-9-9-4 20-7Z" },
  { id: "drafts", name: "Entwürfe", icon: "M12 20h9|M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" },
  { id: "archive", name: "Archiv", icon: "M3 7h18v13H3z|M3 7l2-3h14l2 3|M9 12h6" },
];

interface Mail {
  id: string;
  folder: FolderId;
  from: string;
  fromName: string;
  to: string;
  subject: string;
  preview: string;
  body: string;
  date: string;
  unread: boolean;
  starred: boolean;
}

const MOCK: Mail[] = [
  {
    id: "m1", folder: "inbox", from: "anfrage@muellertech.de", fromName: "MüllerTech GmbH", to: "u1@subunit.ai",
    subject: "Anfrage: KI-Automatisierung für unseren Vertrieb",
    preview: "Guten Tag, wir sind auf Subunit aufmerksam geworden und würden gerne…",
    body: "Guten Tag,\n\nwir sind über LinkedIn auf Subunit aufmerksam geworden und würden gerne besprechen, wie wir unseren Vertriebsprozess mit KI automatisieren können — Lead-Erfassung, Scoring und Follow-ups. Haben Sie nächste Woche Zeit für ein Erstgespräch?\n\nBeste Grüße\nThomas Müller\nGeschäftsführer, MüllerTech GmbH",
    date: "09:42", unread: true, starred: true,
  },
  {
    id: "m2", folder: "inbox", from: "monitor@subunit.ai", fromName: "Subunit Monitor", to: "u1@subunit.ai",
    subject: "✓ Daily-Checkup: alle Systeme nominal",
    preview: "CPU 34% · RAM 62% · Disk 41% · 12/12 Reflexe aktiv · GPU nominal",
    body: "Daily-Checkup 06:00\n\nCPU 34% · RAM 62% · Disk 41%\nDocker: 18/18 Container up\nReflexe: 12/12 aktiv\nGPU: nominal (54°C)\nKosten heute: 0,70 €\n\nKeine Aktion erforderlich.",
    date: "06:00", unread: true, starred: false,
  },
  {
    id: "m3", folder: "inbox", from: "lena@acme.gmbh", fromName: "Lena Schuster (Acme)", to: "u1@subunit.ai",
    subject: "Re: Q3-Plan & nächste Schritte",
    preview: "Danke für die schnelle Antwort! Der Vorschlag passt — lass uns…",
    body: "Hi,\n\ndanke für die schnelle Antwort! Der Vorschlag passt sehr gut. Lass uns am Donnerstag die Details durchgehen. Können wir den Knowledge-Stack auch direkt mit aufsetzen?\n\nViele Grüße\nLena",
    date: "Gestern", unread: false, starred: false,
  },
  {
    id: "m4", folder: "inbox", from: "team@hackernews.digest", fromName: "AI-News-Digest", to: "u1@subunit.ai",
    subject: "Dein täglicher KI-Digest (5 Stories)",
    preview: "Die wichtigsten KI-Themen heute, kuratiert aus HackerNews…",
    body: "Dein KI-Digest — 5 Stories\n\n1. Neues Open-Weight-Modell schlägt GPT-4 in Benchmarks\n2. Agenten-Frameworks im Vergleich\n3. RAG vs. lange Kontexte — was gewinnt?\n…\n\n(generiert vom Research-Skill via reddit-digest)",
    date: "07:30", unread: false, starred: false,
  },
  {
    id: "s1", folder: "sent", from: "u1@subunit.ai", fromName: "Unit One", to: "lena@acme.gmbh",
    subject: "Re: Q3-Plan & nächste Schritte",
    preview: "Hallo Lena, gerne! Anbei der überarbeitete Q3-Plan…",
    body: "Hallo Lena,\n\ngerne! Anbei der überarbeitete Q3-Plan mit den besprochenen Anpassungen. Der Knowledge-Stack lässt sich direkt mit aufsetzen — ich habe das Paket mit eingeplant.\n\nBeste Grüße\nUnit One · Subunit",
    date: "Gestern", unread: false, starred: false,
  },
];

function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("") || "?";
}
function avatarColor(seed: string): string {
  const colors = ["#06b6d4", "#a78bfa", "#f472b6", "#fbbf24", "#34d399", "#fb923c", "#38bdf8"];
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return colors[h % colors.length];
}

function askU1(question: string) {
  window.dispatchEvent(new CustomEvent("u1:ask", { detail: { question } }));
}

function EmailView({ host }: { host: HostApi }) {
  const [mails, setMails] = useState<Mail[]>(MOCK);
  const [folder, setFolder] = useState<FolderId>("inbox");
  const [selId, setSelId] = useState<string | null>("m1");
  const [composing, setComposing] = useState(false);

  const list = useMemo(() => {
    if (folder === "starred") return mails.filter((m) => m.starred);
    return mails.filter((m) => m.folder === folder);
  }, [mails, folder]);

  const sel = mails.find((m) => m.id === selId && (folder === "starred" ? m.starred : m.folder === folder)) ?? null;
  const unreadInbox = mails.filter((m) => m.folder === "inbox" && m.unread).length;

  const open = (id: string) => {
    setSelId(id);
    setMails((ms) => ms.map((m) => (m.id === id ? { ...m, unread: false } : m)));
  };
  const toggleStar = (id: string) =>
    setMails((ms) => ms.map((m) => (m.id === id ? { ...m, starred: !m.starred } : m)));
  const archive = (id: string) => {
    setMails((ms) => ms.map((m) => (m.id === id ? { ...m, folder: "archive" } : m)));
    setSelId(null);
  };

  return (
    <div className="em">
      <EmailStyle />
      <div className="em-grid">
        {/* folders */}
        <nav className="em-folders">
          <button className="btn btn-primary minibtn em-compose" onClick={() => setComposing(true)}>
            <Svg d="M12 5v14M5 12h14" /> Verfassen
          </button>
          {FOLDERS.map((f) => (
            <button key={f.id} className={`em-fold${folder === f.id ? " on" : ""}`} onClick={() => { setFolder(f.id); setSelId(null); }}>
              <span className="em-fold-ic"><Svg d={f.icon} /></span>
              <span className="em-fold-n">{f.name}</span>
              {f.id === "inbox" && unreadInbox > 0 && <span className="em-fold-c">{unreadInbox}</span>}
            </button>
          ))}
          <div className="em-acct"><span className="em-acct-dot" />u1@subunit.ai</div>
        </nav>

        {/* list */}
        <div className="em-list">
          <div className="em-list-h">{FOLDERS.find((f) => f.id === folder)?.name}<span>{list.length}</span></div>
          <div className="em-list-scroll">
            {list.length === 0 ? (
              <div className="em-empty">Keine Nachrichten</div>
            ) : (
              list.map((m) => (
                <button key={m.id} className={`em-row${m.id === selId ? " on" : ""}${m.unread ? " unread" : ""}`} onClick={() => open(m.id)}>
                  <span className="em-av" style={{ background: avatarColor(m.fromName) }}>{initials(m.fromName)}</span>
                  <span className="em-row-tx">
                    <span className="em-row-top"><b>{folder === "sent" ? m.to : m.fromName}</b><span className="em-row-date">{m.date}</span></span>
                    <span className="em-row-subj">{m.subject}</span>
                    <span className="em-row-prev">{m.preview}</span>
                  </span>
                  {m.starred && <span className="em-row-star">★</span>}
                </button>
              ))
            )}
          </div>
        </div>

        {/* reader */}
        <div className="em-read">
          {!sel ? (
            <div className="em-read-empty">
              <span className="em-read-ic"><Svg d="M3 5h18v14H3z|m3 7 9 6 9-6" /></span>
              <b>Wähle eine Nachricht</b>
              <span>Lesen, verwalten und mit U1 bearbeiten.</span>
            </div>
          ) : (
            <>
              <div className="em-read-h">
                <h1>{sel.subject}</h1>
                <div className="em-read-meta">
                  <span className="em-av lg" style={{ background: avatarColor(sel.fromName) }}>{initials(sel.fromName)}</span>
                  <div className="em-read-from">
                    <b>{sel.fromName}</b>
                    <span>{sel.from} · an {sel.to} · {sel.date}</span>
                  </div>
                  <div className="em-read-tools">
                    <button className="em-tool" title="Wichtig" onClick={() => toggleStar(sel.id)} data-on={sel.starred}><Svg d="M12 3l2.9 6 6.6.5-5 4.3 1.6 6.4L12 17l-6.1 3.7 1.6-6.4-5-4.3 6.6-.5z" /></button>
                    <button className="em-tool" title="Archivieren" onClick={() => archive(sel.id)}><Svg d="M3 7h18v13H3z|M3 7l2-3h14l2 3|M9 12h6" /></button>
                  </div>
                </div>
              </div>

              <div className="em-u1bar">
                <button className="em-u1" onClick={() => askU1(`Fasse diese E-Mail in 3 knappen Punkten zusammen:\n\nVon: ${sel.fromName} <${sel.from}>\nBetreff: ${sel.subject}\n\n${sel.body}`)}>
                  <span className="em-u1-sp">✦</span> Zusammenfassen
                </button>
                <button className="em-u1" onClick={() => askU1(`Entwirf eine freundliche, professionelle Antwort auf diese E-Mail (auf Deutsch, im Namen von Subunit/Unit One):\n\nVon: ${sel.fromName} <${sel.from}>\nBetreff: ${sel.subject}\n\n${sel.body}`)}>
                  <span className="em-u1-sp">✦</span> Antwort entwerfen
                </button>
                <button className="em-u1" onClick={() => askU1(`Was ist die beste nächste Aktion zu dieser E-Mail von ${sel.fromName} (Betreff: „${sel.subject}")? Halte es kurz.`)}>
                  <span className="em-u1-sp">✦</span> Nächste Aktion
                </button>
              </div>

              <div className="em-body">{sel.body}</div>

              <div className="em-read-foot">
                <button className="btn btn-primary minibtn" onClick={() => setComposing(true)}><Svg d="M9 17l-5-5 5-5|M4 12h11a4 4 0 0 1 4 4v2" /> Antworten</button>
                <button className="btn-ghost minibtn" onClick={() => setComposing(true)}>Weiterleiten</button>
              </div>
            </>
          )}
        </div>
      </div>

      {composing && <Compose onClose={() => setComposing(false)} onSent={(to) => { setComposing(false); host.notifications.notify("E-Mail gesendet", to); }} prefill={sel} />}
    </div>
  );
}

function Compose({ onClose, onSent, prefill }: { onClose: () => void; onSent: (to: string) => void; prefill: Mail | null }) {
  const [to, setTo] = useState(prefill && prefill.folder !== "sent" ? prefill.from : "");
  const [subject, setSubject] = useState(prefill ? `Re: ${prefill.subject.replace(/^Re:\s*/i, "")}` : "");
  const [bodyTxt, setBodyTxt] = useState("");
  return (
    <div className="em-scrim" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="em-comp" role="dialog" aria-label="Verfassen">
        <div className="em-comp-h">Neue E-Mail<button className="em-x" onClick={onClose}><svg viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12" /></svg></button></div>
        <input className="fld em-comp-f" placeholder="An…" value={to} onChange={(e) => setTo(e.target.value)} />
        <input className="fld em-comp-f" placeholder="Betreff" value={subject} onChange={(e) => setSubject(e.target.value)} />
        <textarea className="fld em-comp-ta" placeholder="Nachricht…" value={bodyTxt} onChange={(e) => setBodyTxt(e.target.value)} />
        <div className="em-comp-foot">
          <button className="em-u1" onClick={() => askU1(`Schreibe eine professionelle E-Mail an ${to || "den Empfänger"}${subject ? ` zum Thema „${subject}"` : ""}. Kurz, freundlich, im Namen von Subunit.`)}><span className="em-u1-sp">✦</span> Mit U1 schreiben</button>
          <div style={{ flex: 1 }} />
          <button className="btn-ghost minibtn" onClick={onClose}>Verwerfen</button>
          <button className="btn btn-primary minibtn" disabled={!to.trim()} onClick={() => onSent(to)}>Senden</button>
        </div>
      </div>
    </div>
  );
}

function EmailStyle() {
  return (
    <style>{`
.em{height:calc(100vh - 56px);width:100%;padding:14px 16px}
.em-grid{display:grid;grid-template-columns:208px 320px 1fr;gap:12px;height:100%}
@media(max-width:1080px){.em-grid{grid-template-columns:64px 280px 1fr}.em-fold-n,.em-acct,.em-compose span{display:none}.em-compose{justify-content:center}}

.em-folders{display:flex;flex-direction:column;gap:3px;padding:12px;border-radius:var(--r-sm);background:var(--glass);backdrop-filter:blur(28px) saturate(1.6);-webkit-backdrop-filter:blur(28px) saturate(1.6);border:1px solid var(--glass-edge);box-shadow:var(--shadow),inset 0 1px 0 var(--rim)}
.em-compose{width:100%;margin-bottom:10px}
.em-compose svg{width:15px;height:15px}
.em-fold{display:flex;align-items:center;gap:10px;padding:9px 10px;border:none;background:none;border-radius:10px;cursor:pointer;font:inherit;font-size:13px;font-weight:550;color:var(--ink2);text-align:left}
.em-fold:hover{background:var(--fill-weak);color:var(--ink)}
.em-fold.on{background:rgba(6,182,212,.1);color:var(--cyan-d,#0891b2);font-weight:650}
.em-fold-ic{flex:none;width:18px;height:18px}.em-fold-ic svg{width:18px;height:18px}
.em-fold-n{flex:1}
.em-fold-c{font-size:11px;font-weight:700;background:var(--cyan);color:#fff;border-radius:999px;padding:1px 7px}
.em-acct{margin-top:auto;padding-top:12px;border-top:1px solid var(--line);font-size:11px;color:var(--ink3);display:flex;align-items:center;gap:7px}
.em-acct-dot{width:7px;height:7px;border-radius:50%;background:#34d399}

.em-list{display:flex;flex-direction:column;border-radius:var(--r-sm);background:var(--glass);backdrop-filter:blur(28px) saturate(1.6);-webkit-backdrop-filter:blur(28px) saturate(1.6);border:1px solid var(--glass-edge);box-shadow:var(--shadow),inset 0 1px 0 var(--rim);overflow:hidden}
.em-list-h{flex:none;display:flex;justify-content:space-between;padding:14px 15px;font-size:13px;font-weight:680;border-bottom:1px solid var(--line)}
.em-list-h span{color:var(--ink3);font-weight:600}
.em-list-scroll{flex:1;overflow-y:auto;padding:6px}
.em-empty{text-align:center;color:var(--ink3);font-size:12.5px;padding:30px}
.em-row{display:flex;gap:10px;width:100%;text-align:left;padding:10px 10px;border:none;background:none;border-radius:11px;cursor:pointer;position:relative}
.em-row:hover{background:var(--fill-weak)}
.em-row.on{background:rgba(6,182,212,.09)}
.em-row.unread::before{content:"";position:absolute;left:2px;top:50%;width:4px;height:4px;border-radius:50%;background:var(--cyan);transform:translateY(-50%)}
.em-av{flex:none;width:34px;height:34px;border-radius:50%;display:grid;place-items:center;color:#fff;font-size:12px;font-weight:700}
.em-av.lg{width:42px;height:42px;font-size:14px}
.em-row-tx{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
.em-row-top{display:flex;justify-content:space-between;gap:8px}
.em-row-top b{font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.em-row.unread .em-row-top b{font-weight:750}
.em-row-date{flex:none;font-size:10.5px;color:var(--ink3)}
.em-row-subj{font-size:12.5px;color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.em-row.unread .em-row-subj{font-weight:600}
.em-row-prev{font-size:11.5px;color:var(--ink3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.em-row-star{color:#fbbf24;font-size:13px}

.em-read{display:flex;flex-direction:column;border-radius:var(--r-sm);background:var(--glass);backdrop-filter:blur(28px) saturate(1.6);-webkit-backdrop-filter:blur(28px) saturate(1.6);border:1px solid var(--glass-edge);box-shadow:var(--shadow),inset 0 1px 0 var(--rim);overflow:hidden}
.em-read-empty{margin:auto;text-align:center;display:flex;flex-direction:column;align-items:center;gap:9px;color:var(--ink2)}
.em-read-empty b{font-size:15px;color:var(--ink)}.em-read-empty span{font-size:12.5px;color:var(--ink3)}
.em-read-ic{width:52px;height:52px;border-radius:15px;display:grid;place-items:center;background:rgba(6,182,212,.1);color:var(--cyan-d)}.em-read-ic svg{width:26px;height:26px}
.em-read-h{flex:none;padding:18px 20px 14px;border-bottom:1px solid var(--line)}
.em-read-h h1{font-size:18px;font-weight:650;letter-spacing:-.02em;line-height:1.3}
.em-read-meta{display:flex;align-items:center;gap:11px;margin-top:13px}
.em-read-from{flex:1;min-width:0}
.em-read-from b{font-size:13.5px;font-weight:650}
.em-read-from span{display:block;font-size:11.5px;color:var(--ink3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.em-read-tools{flex:none;display:flex;gap:5px}
.em-tool{width:34px;height:34px;border-radius:10px;border:1px solid var(--line);background:var(--glass2);cursor:pointer;color:var(--ink2);display:grid;place-items:center}
.em-tool svg{width:16px;height:16px}
.em-tool:hover{color:var(--ink);border-color:var(--line2)}
.em-tool[data-on="true"]{color:#fbbf24;border-color:rgba(251,191,36,.4);background:rgba(251,191,36,.1)}
.em-u1bar{flex:none;display:flex;gap:7px;flex-wrap:wrap;padding:12px 20px;border-bottom:1px solid var(--line);background:linear-gradient(180deg,rgba(6,182,212,.05),transparent)}
.em-u1{display:inline-flex;align-items:center;gap:6px;font:inherit;font-size:12px;font-weight:600;padding:6px 12px;border-radius:999px;border:1px solid rgba(6,182,212,.28);background:rgba(6,182,212,.07);color:var(--cyan-d,#0891b2);cursor:pointer;transition:.15s}
.em-u1:hover{background:rgba(6,182,212,.13);border-color:rgba(6,182,212,.5)}
.em-u1-sp{font-size:11px}
.em-body{flex:1;overflow-y:auto;padding:18px 20px;font-size:14px;line-height:1.65;color:var(--ink);white-space:pre-wrap}
.em-read-foot{flex:none;display:flex;gap:8px;padding:13px 20px;border-top:1px solid var(--line)}
.em-read-foot svg{width:15px;height:15px}

.em-scrim{position:fixed;inset:0;z-index:250;display:grid;place-items:center;background:var(--scrim,rgba(8,16,28,.5));backdrop-filter:blur(5px);animation:em-fade .15s ease}
@keyframes em-fade{from{opacity:0}to{opacity:1}}
.em-comp{width:min(620px,92vw);max-height:80vh;display:flex;flex-direction:column;border-radius:var(--r);border:1px solid var(--glass-edge2,var(--glass-edge));background:var(--menu-bg,var(--glass));backdrop-filter:blur(40px) saturate(1.8);-webkit-backdrop-filter:blur(40px) saturate(1.8);box-shadow:var(--shadow),inset 0 1px 0 var(--rim);padding:18px;animation:em-pop .2s cubic-bezier(.2,.8,.2,1)}
@keyframes em-pop{from{opacity:0;transform:translateY(10px) scale(.98)}to{opacity:1;transform:none}}
.em-comp-h{display:flex;align-items:center;justify-content:space-between;font-size:15px;font-weight:650;margin-bottom:14px}
.em-x{width:30px;height:30px;border-radius:9px;border:none;background:none;cursor:pointer;color:var(--ink3);display:grid;place-items:center}
.em-x:hover{background:var(--fill-weak);color:var(--ink)}.em-x svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round}
.em-comp-f{margin-bottom:9px}
.em-comp-ta{min-height:180px;resize:vertical;line-height:1.55;font-size:14px;margin-bottom:12px}
.em-comp-foot{display:flex;align-items:center;gap:8px}
@media (prefers-reduced-motion:reduce){.em-scrim,.em-comp{animation:none}}
`}</style>
  );
}

let root: Root | null = null;
let offCmd: (() => void) | null = null;

const plugin: PluginModule = {
  manifest: {
    id: "email",
    name: "E-Mail",
    version: "1.0.0",
    description: "Postfach — Mails lesen, verwalten, mit U1 bearbeiten.",
    icon: ICON,
    permissions: ["notifications"],
    nav: { section: "comms", order: 0 },
    commands: [{ id: "open", title: "Go to E-Mail" }],
  },
  mount(container, host) {
    root = createRoot(container);
    root.render(<EmailView host={host} />);
    offCmd = host.events.on("command:email:open", () => host.nav.navigate("email"));
  },
  unmount() {
    offCmd?.();
    offCmd = null;
    root?.unmount();
    root = null;
  },
};

export default plugin;
