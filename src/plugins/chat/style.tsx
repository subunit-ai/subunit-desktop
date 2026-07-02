/**
 * chat/style.tsx — the messenger stylesheet (`.msn-*`), built on the canonical
 * Liquid-Glass tokens (src/styles/subunit-liquid-glass.css). One sheet for the
 * whole messenger: rail, conversation lanes, bubbles, composer, media, menus.
 */

export function MessengerStyle() {
  return (
    <style>{`
.msn{display:grid;grid-template-columns:308px minmax(0,1fr);gap:16px;height:100%;padding:16px 18px 16px;max-width:1280px;margin:0 auto;width:100%}
@media(max-width:860px){.msn{grid-template-columns:1fr}.msn-rail{display:none}}

/* ── avatars + presence ── */
.msn-av{position:relative;flex:none;width:40px;height:40px;border-radius:50%;display:grid;place-items:center;font-size:15px;font-weight:650;color:#fff;background:linear-gradient(160deg,#22d3ee,#06b6d4);box-shadow:inset 0 1px 0 rgba(255,255,255,.3)}
.msn-av.grp{background:linear-gradient(160deg,#818cf8,#6366f1)}
.msn-av.bot{background:linear-gradient(160deg,#0ea5e9,#0369a1)}
.msn-av.ki{background:linear-gradient(160deg,#22d3ee,#06b6d4)}
.msn-av svg{width:20px;height:20px;stroke:#fff}
.msn-av.sm{width:30px;height:30px;font-size:12px}
.msn-av.sm svg{width:15px;height:15px}
.msn-presence{position:absolute;right:-1px;bottom:-1px;width:11px;height:11px;border-radius:50%;background:#34d399;border:2px solid var(--bg,#fff)}
.msn-presence.off{background:var(--ink3)}
html.dark .msn-presence{border-color:#0b1220}

/* ── rail ── */
.msn-rail{background:var(--glass);backdrop-filter:blur(34px) saturate(1.7);-webkit-backdrop-filter:blur(34px) saturate(1.7);border:1px solid var(--glass-edge);border-radius:var(--r);box-shadow:var(--shadow),inset 0 1px 0 var(--rim);padding:14px;display:flex;flex-direction:column;min-height:0}
.msn-rail-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;gap:8px}
.msn-new-wrap{position:relative}
.msn-new .ic{width:32px;height:32px;border-radius:10px}
.msn-new .ic svg{width:16px;height:16px}
.msn-menu{position:absolute;top:calc(100% + 6px);right:0;z-index:30;width:252px;max-height:380px;overflow-y:auto;padding:6px;border-radius:var(--r-sm);border:1px solid var(--glass-edge2,var(--glass-edge));background:var(--menu-bg,var(--glass));backdrop-filter:blur(34px) saturate(1.7);-webkit-backdrop-filter:blur(34px) saturate(1.7);box-shadow:var(--shadow),inset 0 1px 0 var(--rim)}
.msn-menu-h{font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--ink3);padding:7px 9px 6px}
.msn-menu-i{display:flex;align-items:center;gap:9px;width:100%;text-align:left;padding:8px 8px;border:none;background:none;border-radius:9px;cursor:pointer;font:inherit;font-size:13px;color:var(--ink)}
.msn-menu-i:hover{background:var(--fill-weak)}
.msn-menu-i svg{width:16px;height:16px;color:var(--ink2);flex:none}
.msn-menu-i .n{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.msn-menu-empty{font-size:12px;color:var(--ink3);padding:8px 9px;line-height:1.5}
.msn-menu-sep{height:1px;background:var(--line);margin:5px 6px}

.msn-search{position:relative;margin-bottom:8px}
.msn-search svg{position:absolute;left:11px;top:50%;transform:translateY(-50%);width:14px;height:14px;color:var(--ink3);pointer-events:none}
.msn-search input{width:100%;font:inherit;font-size:13px;color:var(--ink);background:var(--fill-weak);border:1px solid var(--line);border-radius:12px;padding:8px 12px 8px 32px;outline:none}
.msn-search input:focus{border-color:rgba(6,182,212,.4)}

.msn-chips{display:flex;gap:4px;margin-bottom:8px}
.msn-chip{font:inherit;font-size:11px;font-weight:650;padding:5px 10px;border-radius:999px;border:1px solid var(--line);background:none;color:var(--ink3);cursor:pointer;transition:.14s}
.msn-chip:hover{color:var(--ink)}
.msn-chip.on{background:linear-gradient(160deg,#22d3ee,#06b6d4);border-color:transparent;color:#fff;box-shadow:0 3px 9px -4px rgba(6,182,212,.7)}

.msn-items{display:flex;flex-direction:column;gap:4px;overflow-y:auto;min-height:0;flex:1}
.msn-item{display:flex;align-items:center;gap:11px;text-align:left;width:100%;border:1px solid transparent;border-radius:var(--r-xs);background:transparent;padding:9px 10px;cursor:pointer;font-family:inherit;color:inherit;transition:background .16s,border-color .16s}
.msn-item:hover{background:var(--glass2)}
.msn-item.is-active{background:rgba(6,182,212,.1);border-color:rgba(6,182,212,.28);box-shadow:inset 0 1px 0 var(--rim)}
.msn-item-tx{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.msn-item-top{display:flex;align-items:baseline;justify-content:space-between;gap:8px}
.msn-item-title{font-size:13.5px;font-weight:600;letter-spacing:-.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--ink)}
.msn-item.is-active .msn-item-title{color:var(--cyan-d)}
.msn-item-time{font-size:10.5px;color:var(--ink3);flex:none}
.msn-item-prev{font-size:12px;color:var(--ink3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.msn-unread{flex:none;min-width:18px;height:18px;padding:0 5px;border-radius:999px;background:linear-gradient(160deg,#22d3ee,#06b6d4);color:#fff;font-size:10.5px;font-weight:700;display:grid;place-items:center}
.msn-unread.dot{min-width:10px;width:10px;height:10px;padding:0}
.msn-rail-empty{display:flex;flex-direction:column;align-items:center;gap:8px;color:var(--ink3);font-size:13px;text-align:center;padding:30px 8px;line-height:1.5}
.msn-sect{font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--ink3);padding:8px 6px 3px}

/* ── conversation shell ── */
.msn-conv{display:flex;flex-direction:column;min-height:0;background:var(--glass);backdrop-filter:blur(34px) saturate(1.7);-webkit-backdrop-filter:blur(34px) saturate(1.7);border:1px solid var(--glass-edge);border-radius:var(--r);box-shadow:var(--shadow),inset 0 1px 0 var(--rim);overflow:hidden}
.msn-conv-blank{margin:auto;text-align:center;display:flex;flex-direction:column;align-items:center;gap:12px;max-width:38ch;padding:30px}
.msn-blank-ic{width:58px;height:58px;border-radius:18px;display:grid;place-items:center;background:rgba(6,182,212,.1);color:var(--cyan-d)}
.msn-blank-ic svg{width:28px;height:28px}
.msn-conv-blank b{font-size:18px;font-weight:600;letter-spacing:-.02em;color:var(--ink)}

.msn-head{display:flex;align-items:center;gap:12px;padding:13px 16px;border-bottom:1px solid var(--line)}
.msn-head-tx{min-width:0;flex:1}
.msn-head-title{font-size:15.5px;font-weight:600;letter-spacing:-.015em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.msn-head-sub{font-size:12px;color:var(--ink2);margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.msn-head-actions{display:flex;align-items:center;gap:4px;flex:none;position:relative}
.msn-hbtn{display:grid;place-items:center;width:32px;height:32px;border-radius:10px;border:none;background:none;color:var(--ink2);cursor:pointer;transition:.14s}
.msn-hbtn:hover{background:var(--fill-weak);color:var(--ink)}
.msn-hbtn svg{width:17px;height:17px}
.msn-hbtn.on{background:rgba(6,182,212,.12);color:var(--cyan-d)}
.msn-findbar{display:flex;align-items:center;gap:8px;padding:8px 16px;border-bottom:1px solid var(--line);background:var(--fill-soft,transparent)}
.msn-findbar input{flex:1;font:inherit;font-size:13px;color:var(--ink);background:var(--fill-weak);border:1px solid var(--line);border-radius:10px;padding:6px 11px;outline:none}
.msn-findbar .cnt{font-size:11.5px;color:var(--ink3);flex:none}
.msn-model{flex:none;display:flex;gap:2px;padding:2px;border-radius:999px;background:var(--fill-weak);border:1px solid var(--line)}
.msn-model-b{font:inherit;font-size:10.5px;font-weight:650;padding:4px 10px;border-radius:999px;border:none;background:none;color:var(--ink3);cursor:pointer;transition:.14s}
.msn-model-b:hover{color:var(--ink)}
.msn-model-b.on{background:linear-gradient(160deg,#22d3ee,#06b6d4);color:#fff;box-shadow:0 3px 9px -4px rgba(6,182,212,.7)}

/* pinned bar */
.msn-pinbar{display:flex;align-items:center;gap:9px;padding:8px 16px;border-bottom:1px solid var(--line);background:rgba(6,182,212,.06);cursor:pointer}
.msn-pinbar svg{width:14px;height:14px;color:var(--cyan-d);flex:none}
.msn-pinbar-tx{flex:1;min-width:0;font-size:12.5px;color:var(--ink2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.msn-pinbar-tx b{color:var(--cyan-d);margin-right:6px}

/* ── body / messages ── */
.msn-body-scroll{flex:1;overflow-y:auto;min-height:0;padding:20px 20px 8px;display:flex;flex-direction:column;gap:8px}
.msn-empty{margin:auto;color:var(--ink3);font-size:13px;padding:30px;text-align:center;line-height:1.6}
.msn-datesep{display:flex;justify-content:center;padding:6px 0 2px}
.msn-datesep span{font-size:11px;font-weight:650;color:var(--ink3);background:var(--fill-weak);border:1px solid var(--line);border-radius:999px;padding:3px 11px}

.msn-msg{display:flex;align-items:flex-end;gap:9px;max-width:76%}
.msn-msg.me{align-self:flex-end;flex-direction:row-reverse}
.msn-msg.them{align-self:flex-start}
.msn-msg-av{flex:none;margin-bottom:2px}
.msn-msg-col{display:flex;flex-direction:column;gap:3px;min-width:0;align-items:flex-start}
.msn-msg.me .msn-msg-col{align-items:flex-end}
.msn-msg-sender{font-size:10.5px;font-weight:700;color:var(--cyan-d,#0891b2);padding:0 4px}
.msn-bubble-wrap{position:relative;display:flex;align-items:center;gap:6px;max-width:100%}
.msn-msg.me .msn-bubble-wrap{flex-direction:row-reverse}
.msn-bubble{position:relative;font-size:14.5px;line-height:1.5;padding:9px 13px;border-radius:16px;white-space:pre-wrap;word-break:break-word;box-shadow:var(--shadow-sm);min-width:0}
.msn-msg.them .msn-bubble{background:var(--fill-strong);border:1px solid var(--line);color:var(--prose);border-bottom-left-radius:5px}
.msn-msg.me .msn-bubble{background:linear-gradient(160deg,#22d3ee,#06b6d4);color:#fff;border-bottom-right-radius:5px}
.msn-body mark{background:rgba(250,204,21,.55);color:inherit;border-radius:3px;padding:0 1px}
.msn-deleted{opacity:.6}
.msn-meta{display:inline-flex;align-items:center;gap:5px;font-size:10px;opacity:.72;margin-left:8px;vertical-align:bottom;white-space:nowrap;float:right;margin-top:8px}
.msn-msg.them .msn-meta{color:var(--ink3);opacity:1}
.msn-edited,.msn-cost{font-style:italic}
.msn-read svg{width:13px;height:13px}
.msn-read.on{color:#bef9ff}
.msn-msg.them .msn-read.on{color:var(--cyan-d)}

.msn-quote{display:flex;flex-direction:column;gap:1px;border-left:2.5px solid rgba(255,255,255,.65);padding:3px 8px;margin-bottom:6px;border-radius:6px;background:rgba(255,255,255,.14);font-size:12.5px}
.msn-msg.them .msn-quote{border-left-color:var(--cyan-d);background:var(--fill-weak)}
.msn-quote b{font-size:11px}
.msn-quote span{opacity:.85;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:38ch}

/* hover actions */
.msn-acts{position:relative;display:none;align-items:center;gap:2px;flex:none}
.msn-bubble-wrap:hover .msn-acts{display:flex}
.msn-act{display:grid;place-items:center;width:26px;height:26px;border-radius:8px;border:none;background:var(--fill-weak);color:var(--ink2);cursor:pointer;transition:.13s;font:inherit;font-size:10.5px}
.msn-act:hover{background:var(--fill-mid,var(--fill-weak));color:var(--ink)}
.msn-act svg{width:14px;height:14px}
.msn-act.danger:hover{color:#dc2626}
.msn-act.confirm{width:auto;padding:0 8px;color:#dc2626;font-weight:700}
.msn-pick{position:absolute;bottom:calc(100% + 6px);right:0;z-index:25;display:flex;gap:2px;padding:5px;border-radius:999px;border:1px solid var(--glass-edge2,var(--glass-edge));background:var(--menu-bg,var(--glass));backdrop-filter:blur(34px) saturate(1.7);-webkit-backdrop-filter:blur(34px) saturate(1.7);box-shadow:var(--shadow)}
.msn-pick-e{font-size:17px;line-height:1;padding:5px;border-radius:50%;border:none;background:none;cursor:pointer;transition:transform .12s}
.msn-pick-e:hover{transform:scale(1.25)}

/* reactions */
.msn-reacts{display:flex;flex-wrap:wrap;gap:4px;padding:0 2px}
.msn-react{display:inline-flex;align-items:center;gap:4px;font:inherit;font-size:13px;line-height:1;padding:3px 8px;border-radius:999px;border:1px solid var(--line);background:var(--fill-weak);cursor:pointer;transition:.13s}
.msn-react span{font-size:11px;font-weight:700;color:var(--ink2)}
.msn-react.mine{background:rgba(6,182,212,.14);border-color:rgba(6,182,212,.4)}
.msn-react:hover{transform:scale(1.06)}

/* attachments */
.msn-att-img{display:block;max-width:320px;max-height:280px;border-radius:12px;margin:2px 0 6px;object-fit:cover}
.msn-att-loading{width:220px;height:140px;background:var(--fill-weak);animation:msn-pulse 1.4s infinite ease-in-out}
@keyframes msn-pulse{0%,100%{opacity:.55}50%{opacity:1}}
.msn-att-audio{display:flex;align-items:center;gap:8px;margin:2px 0 6px}
.msn-att-audio audio{height:36px;max-width:260px}
.msn-att-dur{font-size:11px;opacity:.8}
.msn-att-load{font-size:12px;opacity:.7}
.msn-att-file{display:flex;align-items:center;gap:9px;margin:2px 0 6px;padding:8px 10px;border-radius:12px;background:rgba(255,255,255,.14);color:inherit;text-decoration:none;max-width:280px}
.msn-msg.them .msn-att-file{background:var(--fill-weak)}
.msn-att-file-ic{display:grid;place-items:center;width:30px;height:30px;border-radius:9px;background:rgba(255,255,255,.2);flex:none}
.msn-msg.them .msn-att-file-ic{background:var(--fill-mid,var(--fill-weak))}
.msn-att-file-ic svg{width:15px;height:15px}
.msn-att-file-n{flex:1;min-width:0;font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.msn-att-file-dl svg{width:14px;height:14px;opacity:.8}

/* typing dots */
.msn-typing{display:flex;align-items:center;gap:5px;padding:3px}
.msn-typing i{width:7px;height:7px;border-radius:50%;background:var(--ink3);animation:msn-bounce 1.2s infinite ease-in-out}
.msn-typing i:nth-child(2){animation-delay:.18s}
.msn-typing i:nth-child(3){animation-delay:.36s}
@keyframes msn-bounce{0%,60%,100%{transform:translateY(0);opacity:.4}30%{transform:translateY(-4px);opacity:1}}

.msn-err{align-self:center;font-size:12px;color:#dc2626;background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.2);border-radius:10px;padding:9px 13px;line-height:1.4;text-align:center;max-width:52ch}

/* ── composer ── */
.msn-composer-wrap{border-top:1px solid var(--line)}
.msn-bar{display:flex;align-items:center;gap:10px;padding:8px 16px 0}
.msn-bar-ic{display:grid;place-items:center;width:26px;height:26px;color:var(--cyan-d);flex:none}
.msn-bar-ic svg{width:15px;height:15px}
.msn-bar.edit .msn-bar-ic{color:#f59e0b}
.msn-bar-tx{flex:1;min-width:0;display:flex;flex-direction:column;border-left:2.5px solid var(--cyan-d);padding-left:9px}
.msn-bar.edit .msn-bar-tx{border-left-color:#f59e0b}
.msn-bar-tx b{font-size:11.5px;color:var(--cyan-d)}
.msn-bar.edit .msn-bar-tx b{color:#f59e0b}
.msn-bar-tx span{font-size:12.5px;color:var(--ink2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.msn-bar-x{display:grid;place-items:center;width:24px;height:24px;border-radius:8px;border:none;background:none;color:var(--ink3);cursor:pointer;flex:none}
.msn-bar-x:hover{background:var(--fill-weak);color:var(--ink)}
.msn-bar-x svg{width:13px;height:13px}
.msn-pending{display:flex;flex-wrap:wrap;gap:6px;padding:8px 16px 0}
.msn-chipatt{display:inline-flex;align-items:center;gap:7px;font-size:12px;color:var(--ink);background:var(--fill-weak);border:1px solid var(--line);border-radius:999px;padding:4px 6px 4px 10px;max-width:280px}
.msn-chipatt svg{width:13px;height:13px;color:var(--ink2);flex:none}
.msn-chipatt-n{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.msn-chipatt.failed{color:#dc2626;border-color:rgba(239,68,68,.35)}
.msn-minispin{width:12px;height:12px;border-radius:50%;border:2px solid var(--line);border-top-color:var(--cyan-d);animation:msn-rot .7s linear infinite;flex:none}
.msn-composer{display:flex;align-items:flex-end;gap:8px;padding:12px 16px 14px}
.msn-input{margin-top:0;min-height:46px;max-height:160px;resize:none;line-height:1.5;padding:12px 14px;flex:1}
.msn-cbtn{display:grid;place-items:center;width:40px;height:46px;border-radius:14px;border:none;background:none;color:var(--ink2);cursor:pointer;flex:none;transition:.14s}
.msn-cbtn:hover{background:var(--fill-weak);color:var(--ink)}
.msn-cbtn svg{width:19px;height:19px}
.msn-cbtn.rec-stop{color:#dc2626}
.msn-rec{flex:1;display:flex;align-items:center;gap:10px;min-height:46px;padding:0 14px;border-radius:14px;background:rgba(239,68,68,.07);border:1px solid rgba(239,68,68,.25)}
.msn-rec-dot{width:10px;height:10px;border-radius:50%;background:#ef4444;animation:msn-pulse 1.1s infinite}
.msn-rec-t{font-size:13px;font-weight:650;color:#dc2626;flex:1}
.msn-send{width:auto;flex:none;padding:13px 15px}
.msn-send svg{width:18px;height:18px}
.msn-spin{width:16px;height:16px;border-radius:50%;border:2px solid rgba(255,255,255,.4);border-top-color:#fff;animation:msn-rot .7s linear infinite;display:inline-block}
@keyframes msn-rot{to{transform:rotate(360deg)}}

/* group dialog */
.msn-overlay{position:absolute;inset:0;z-index:40;display:grid;place-items:center;background:rgba(10,18,28,.25);backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px)}
.msn-dialog{width:min(400px,92%);max-height:80%;overflow-y:auto;padding:18px;border-radius:var(--r-sm);border:1px solid var(--glass-edge);background:var(--menu-bg,var(--glass));backdrop-filter:blur(34px) saturate(1.7);-webkit-backdrop-filter:blur(34px) saturate(1.7);box-shadow:var(--shadow)}
.msn-dialog h3{margin:0 0 12px;font-size:15px;font-weight:650;letter-spacing:-.01em}
.msn-dialog .fld{width:100%}
.msn-dlg-users{display:flex;flex-direction:column;gap:2px;margin:10px 0;max-height:220px;overflow-y:auto}
.msn-dlg-u{display:flex;align-items:center;gap:9px;padding:7px 8px;border-radius:9px;border:none;background:none;cursor:pointer;font:inherit;font-size:13px;color:var(--ink);text-align:left}
.msn-dlg-u:hover{background:var(--fill-weak)}
.msn-dlg-u .box{width:16px;height:16px;border-radius:5px;border:1.5px solid var(--line2,var(--line));display:grid;place-items:center;flex:none}
.msn-dlg-u.on .box{background:linear-gradient(160deg,#22d3ee,#06b6d4);border-color:transparent}
.msn-dlg-u .box svg{width:11px;height:11px;stroke:#fff}
.msn-dlg-foot{display:flex;justify-content:flex-end;gap:8px;margin-top:12px}

/* global error toast */
.msn-toast{position:absolute;bottom:18px;left:50%;transform:translateX(-50%);z-index:50;max-width:52ch;font-size:12.5px;line-height:1.4;color:#fff;background:rgba(220,38,38,.92);border:1px solid rgba(239,68,68,.5);border-radius:12px;padding:10px 15px;box-shadow:var(--shadow);cursor:pointer;backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);animation:msn-toast-in .2s ease}
@keyframes msn-toast-in{from{opacity:0;transform:translate(-50%,8px)}to{opacity:1;transform:translate(-50%,0)}}

@media (prefers-reduced-motion:reduce){.msn-typing i,.msn-spin,.msn-minispin,.msn-rec-dot,.msn-att-loading,.msn-toast{animation:none}}
`}</style>
  );
}
