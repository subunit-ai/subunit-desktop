# u1chat-messenger — Staging für den „Messenger"-Deploy (Bots mit Account-ACL + Telegram-Parity-Wellen)

> **Nachtrag 2026-07-03 (u1):** Der Messenger-Deploy LIEF (2026-07-03 01:15, Backups
> `*.bak-messenger-20260703-011538`, bridge.sh inklusive). `baseline/` wurde auf diesen
> Live-Stand aufgefrischt (== `recon/`). `next/` enthält jetzt DREI neue Deltas:
> 1. **Anhänge-Persistenz an KI-Thread-Messages** (db.ts: additive `attachments`-Spalte +
>    addMessage/getMessages; server.ts: attMeta persistieren, attachments-only-Send erlaubt,
>    Auflösung VOR acquireStream gegen Slot-Leak, classify-Fallback auf Anhang-Namen).
> 2. **`GET /api/search?q=`** — globale Nachrichten-Suche (Team=Membership, KI=op+owner,
>    Bots=ACL; LIKE+ESCAPE, je 20, neueste zuerst).
> 3. **`POST /api/team/convos/:id/forward`** — server-seitiges Weiterleiten (team|bot|ki →
>    Team-Convo, re-verlinkt Anhänge via team_msg_attachments).
> `bun build` grün. Desktop-Client (v0.7.0+commits) hat Capability-Probe: Suche/Forward
> erscheinen erst nach diesem Deploy. **Deploy TJ-gated:** `./deploy.sh` (Guard/Backup/
> Health/Rollback wie gehabt; Baseline == Live-Stand 01:15).

Staged 2026-07-02 gegen den Live-Stand von `~/subunit/unitone/workspace/projects/u1-chat`
(Checksummen in `baseline/SHA256SUMS`). Spezifikation: `CONTRACT-messenger.md` (Scratchpad, Abschnitte B/C/D).

## Inhalt

| Pfad | Was |
|---|---|
| `baseline/` | Live-Snapshot server.ts/db.ts/claude.ts/email.ts + `SHA256SUMS` (Deploy-Guard) |
| `next/` | Fertig gepatchte server.ts (1262 L) + db.ts (506 L); claude.ts/email.ts unverändert (nur für Build-Check) |
| `patches/` | Reproduzierbare Transformation baseline→next: `wave-{reactions,reply,editdelete,readstate,groups}.py` (aus den iOS-Scripts extrahiert), `wave-media-reconciled.py` (media auf post-reply-Zustand rekonziliert), `bot-module.py`, `widening.py`, `attachments-on-delete.py`, `review-hardening.py` — Reihenfolge exakt so |

> **Nachtrag 2026-07-02 (post-Review, u1-Hand):** Nach der adversarialen Backend-Review wurden direkt in `next/` + den Scripts ergänzt (NICHT als eigener Patch — deploy.sh nutzt `next/` direkt, der Guard prüft live==baseline, nicht patches==next):
> - `next/db.ts` `lastBotMessage` + `next/server.ts` `botDto`: **`last_sender`** (Desktop braucht es für Bot-Unread/Notify je Absender).
> - `deploy.sh`: **TOCTOU-Re-Check** direkt vor dem Swap + **atomarer `.new`+`mv`-Swap** + `pipefail` (leeres Secret verhindern).
> - `auth-widening.sh`: hartes **`CONFIRM=DEPLOY`/interaktives Gate** + curl-Härtung (`|| echo 000`), damit `set -e` den Rollback nicht überspringt.
> - **Bewusst akzeptiert (LOW):** `bridge.sh` tg-send in-place-Rewrite (Millisekunden-Truncate-Fenster, selten gleichzeitig gelesen); `/api/uploads`-Speicherpuffer (pre-existing, = baseline); `/api/team/users` zeigt Dirk das interne Directory (workspace-intern, ok).
> Verifiziert: `bun build next/server.ts` grün, `bash -n` aller drei Scripts grün.
| `deploy.sh` | Atomarer Swap aufs Live-Backend (Guard→Backup→Build-Check→Swap→.env→Restart→Health, Auto-Rollback) |
| `bridge.sh` | Additiv: Secret + tg-send-app:-Branch + CLAUDE.md-Regel in 4 Workdirs. Kein Restart. |
| `auth-widening.sh` | ⛔️ GATED (TJ-Go!): subunit-auth sso.ts — `extraEmails` für die u1-chat-SSO-App (Dirk via Web/iOS-SSO) |

## Reihenfolge

1. **`./deploy.sh`** — bricht ab, wenn die Live-Dateien nicht mehr der Baseline entsprechen
   (dann: Baseline neu ziehen, `patches/` in Reihenfolge neu anwenden, neu bauen).
2. **`./bridge.sh`** — danach; additiv, jederzeit wiederholbar (Marker-idempotent).
3. **`./auth-widening.sh`** — NUR nach explizitem TJ-Go (restartet den zentralen Auth-Dienst).
   Nur nötig für Dirks **Web/iOS-SSO**; der Desktop-Bearer-Weg funktioniert ohne
   (u1-chat prüft den JWT selbst via `emailAllowed`). Dirk braucht außerdem einen
   auth.subunit.ai-Account mit verifizierter Email (separat provisionieren).

## Gates / Voraussetzungen

- `deploy.sh`-Guard: sha256(Live server.ts/db.ts/claude.ts/email.ts) == `baseline/SHA256SUMS`.
- Secret `~/.config/unitone/bot-ingest-secret` wird von deploy.sh/bridge.sh erzeugt falls fehlend
  (Stand Staging: fehlt) und landet als `U1_CHAT_BOT_INGEST_SECRET` in der u1-chat `.env`.
- `.env` bekommt zusätzlich `U1_CHAT_EXTRA_EMAILS=dirk.jedlitschka@idolz.com` (idempotent).
- tmux-Sessions verifiziert vorhanden (2026-07-02): `unitone`, `unitone-group`, `unitone-erik`, `unitone-dirk`.
- tg-send-Anker (`if not text.strip(): die("leerer text")`) verifiziert 1× vorhanden; nur EINE
  tg-send-Kopie in `~/.config/unitone/bin/` (Stand 2026-07-02).

## Rollback

- `deploy.sh` rollbackt ab Schritt (d) automatisch: Backup zurück + Restart + Health-Ausgabe.
  Manuell: auf dem Server `cp server.ts.bak-messenger-<STAMP> server.ts && cp db.ts.bak-messenger-<STAMP> db.ts && systemctl --user restart unitone-chat`.
- DB-Migrationen (bot_messages, reactions, read_state, Spalten-ALTERs) sind rein **additiv** —
  der alte Code läuft mit der migrierten DB unverändert weiter, kein DB-Rollback nötig.
- `bridge.sh`: tg-send-Backup `tg-send.bak-messenger-<STAMP>` zurückkopieren; CLAUDE.md-Blöcke
  am Marker `<!-- SUBUNIT-APP-CHANNEL -->` entfernen (oder `.bak-messenger-<STAMP>` zurück).
- `auth-widening.sh` rollbackt automatisch bei Build-/Health-Fehler; manuell: `sso.ts.bak-messenger-<STAMP>`.

## Pilot-Plan (nacheinander, nicht alles auf einmal)

1. **u1-private** (nur TJ): Desktop → Bot `u1` → Nachricht senden → Antwort kommt via
   `tg-send 'app:u1-private' …` zurück (reply_hint wirkt sofort, ohne CLAUDE.md-Reload).
   Prüfen: Persist (Reload zeigt Verlauf), SSE-Live, Reaction auf eine Bot-Nachricht.
2. **u1-group** (TJ + Erik): beide senden, beide sehen beide Nachrichten (geteilter Raum);
   Absender steht im `user=`-Attribut des injizierten Tags.
3. **u1-erik** (nur Erik), dann **u1-dirk** (nur Dirk — braucht vorher auth-widening.sh
   + Account-Provisionierung, wenn Dirk per iOS/Web kommt; Desktop-Bearer geht ohne Widening).
4. Team-Wellen (Reactions/Reply/Edit/Delete/Read/Typing/Pins/Media) im Team-Chat TJ↔Erik testen.

## Bewusste Entscheidungen (Contract)

- Bot-Räume sind GETEILT mit ACL (nicht owner-scoped wie im alten iOS-Script); `gate` bewusst
  nicht im Roster. Kein Edit/Delete für Bot-Nachrichten. Bot-Unread client-seitig.
- `/internal/bot-reply` steht VOR Origin-Check/Auth (nur safeEqual-Secret), chat_id-Format `app:<botId>`.
- `GET /api/bots` liefert zusätzlich `last_role` (user|bot|null) für client-seitige Unread-Badges
  (Contract-Update 2026-07-02).
- Team-Soft-Delete blankt auch `attachments` (auf `''`, NICHT NULL — Spalte ist NOT NULL DEFAULT '';
  Koordinator-Nachtrag 2026-07-02). `team_msg_attachments`-Links bleiben bewusst bestehen
  (Media-GET prüft Convo-Membership; verwaiste Links sind ok).
