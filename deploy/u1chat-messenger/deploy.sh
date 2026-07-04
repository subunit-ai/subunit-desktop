#!/bin/bash
# deploy.sh — ATOMARER Deploy der u1-chat "Messenger"-Erweiterung (6 Parity-Wellen + Bot-Modul + emailAllowed-Widening).
#
# Ablauf (Contract D):
#   (a) Checksummen-Guard: Live-Dateien auf dem Server == baseline/SHA256SUMS, sonst ABBRUCH
#   (b) Backup live server.ts/db.ts mit Zeitstempel
#   (c) scp next/server.ts+db.ts in Server-Temp, dort bun-build-Check (VOR Swap)
#   (d) Swap
#   (e) .env-Ergänzungen idempotent (U1_CHAT_BOT_INGEST_SECRET aus ~/.config/unitone/bot-ingest-secret
#       — wird erzeugt falls fehlt (uuidgen ohne Bindestriche, chmod 600) — + U1_CHAT_EXTRA_EMAILS)
#   (f) systemctl --user restart unitone-chat
#   (g) Health: GET / == 302 UND GET /api/bots (unauth) == 401
#   (h) bei jedem Fehler ab (d): automatischer Rollback aufs Backup + Restart + Health
#
# AUSFÜHREN (vom Mac): ./deploy.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SRV_HOST=subunit-server
STAMP=$(date +%Y%m%d-%H%M%S)

[ -f "$HERE/baseline/SHA256SUMS" ] || { echo "❌ baseline/SHA256SUMS fehlt"; exit 1; }
[ -f "$HERE/next/server.ts" ] && [ -f "$HERE/next/db.ts" ] || { echo "❌ next/server.ts oder next/db.ts fehlt"; exit 1; }

echo "=== (a) Checksummen-Guard: Live == Baseline? ==="
REMOTE_SUMS=$(ssh "$SRV_HOST" 'cd ~/subunit/unitone/workspace/projects/u1-chat && sha256sum server.ts db.ts claude.ts email.ts')
if ! diff <(echo "$REMOTE_SUMS" | awk '{print $1, $2}' | sort) <(awk '{print $1, $2}' "$HERE/baseline/SHA256SUMS" | sort) >/dev/null; then
  echo "❌ ABBRUCH: Live-Dateien auf dem Server weichen von baseline/ ab."
  echo "   Das Live-Backend wurde seit dem Staging verändert (z. B. durch Server-u1)."
  echo "   → Baseline neu ziehen, Wellen/Patches neu anwenden (patches/), dann erneut deployen."
  echo "--- live ---";     echo "$REMOTE_SUMS"
  echo "--- baseline ---"; cat "$HERE/baseline/SHA256SUMS"
  exit 1
fi
echo "✅ Checksummen identisch — Staging-Basis ist der Live-Stand."

echo "=== (b) Backup + (c) Upload nach Temp + bun-build-Check (vor Swap) ==="
ssh "$SRV_HOST" "mkdir -p /tmp/u1chat-next-$STAMP"
scp -q "$HERE/next/server.ts" "$HERE/next/db.ts" "$HERE/baseline/SHA256SUMS" "$SRV_HOST:/tmp/u1chat-next-$STAMP/"
ssh "$SRV_HOST" bash -s -- "$STAMP" <<'PRECHECK'
set -euo pipefail
STAMP="$1"
DIR="$HOME/subunit/unitone/workspace/projects/u1-chat"
TMP="/tmp/u1chat-next-$STAMP"
BUN="$(command -v bun || echo "$HOME/.bun/bin/bun")"
cp "$DIR/server.ts" "$DIR/server.ts.bak-messenger-$STAMP"
cp "$DIR/db.ts"     "$DIR/db.ts.bak-messenger-$STAMP"
echo "✅ Backups: server.ts/db.ts.bak-messenger-$STAMP"
cp "$DIR/claude.ts" "$DIR/email.ts" "$TMP/"
cd "$TMP"
if ! "$BUN" build --target=bun ./server.ts >/dev/null 2>/tmp/u1chat-buildcheck-$STAMP.err; then
  echo "❌ ABBRUCH: bun-build-Check der next-Dateien fehlgeschlagen (Live UNVERÄNDERT):"
  head -30 "/tmp/u1chat-buildcheck-$STAMP.err"
  exit 1
fi
echo "✅ bun build OK (Temp)"
PRECHECK

echo "=== (d)-(h) Kritischer Abschnitt: Swap + .env + Restart + Health (mit Auto-Rollback) ==="
ssh "$SRV_HOST" bash -s -- "$STAMP" <<'REMOTE'
set -uo pipefail   # pipefail: eine sterbende uuidgen darf kein leeres Secret durchreichen
STAMP="$1"
DIR="$HOME/subunit/unitone/workspace/projects/u1-chat"
TMP="/tmp/u1chat-next-$STAMP"
rollback() {
  echo "❌ FEHLER: $1 — AUTOMATISCHER ROLLBACK aufs Backup"
  cp "$DIR/server.ts.bak-messenger-$STAMP" "$DIR/server.ts"
  cp "$DIR/db.ts.bak-messenger-$STAMP"     "$DIR/db.ts"
  systemctl --user restart unitone-chat
  sleep 3
  echo "   Rollback-Service: $(systemctl --user is-active unitone-chat)"
  echo "   Rollback-Health GET /: $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/)"
  exit 1
}
# (c2) TOCTOU-Re-Check DIREKT vor dem Swap (schließt das Fenster seit dem Guard in Session 1):
# hier wurde noch nichts geändert → ABBRUCH ohne Rollback ist sauber.
LIVE_NOW=$(cd "$DIR" && sha256sum server.ts db.ts claude.ts email.ts | awk '{print $1, $2}' | sort)
BASE_EXP=$(awk '{print $1, $2}' "$TMP/SHA256SUMS" | sort)
if [ "$LIVE_NOW" != "$BASE_EXP" ]; then
  echo "❌ ABBRUCH (vor Swap): Live-Dateien haben sich seit dem Guard geändert (paralleler Server-u1-Edit?)."
  echo "   Nichts angefasst. → Baseline neu ziehen + patches neu, dann erneut deployen."
  exit 1
fi
# (d) ATOMARER Swap: erst beide .new anlegen (ungeladen, unkritisch), dann per mv (atomarer rename)
# einschwenken — ein SSH-Abbruch hinterlässt so nie eine halb-getauschte Datei-Paarung.
cp "$TMP/server.ts" "$DIR/server.ts.new-$STAMP" || rollback "stage server.ts.new"
cp "$TMP/db.ts"     "$DIR/db.ts.new-$STAMP"     || rollback "stage db.ts.new"
mv -f "$DIR/server.ts.new-$STAMP" "$DIR/server.ts" || rollback "mv server.ts"
mv -f "$DIR/db.ts.new-$STAMP"     "$DIR/db.ts"     || rollback "mv db.ts"
echo "✅ (d) Atomarer Swap (Re-Check bestanden)"
# (e) Secret erzeugen falls fehlt + .env idempotent ergänzen (Werte werden NIE ausgegeben)
SECRET_FILE="$HOME/.config/unitone/bot-ingest-secret"
if [ ! -s "$SECRET_FILE" ]; then
  mkdir -p "$(dirname "$SECRET_FILE")" || rollback "mkdir secret-dir"
  (umask 177 && uuidgen | tr -d '-' > "$SECRET_FILE") || rollback "secret erzeugen"
  chmod 600 "$SECRET_FILE" || rollback "secret chmod"
  echo "✅ (e) bot-ingest-secret erzeugt (0600)"
fi
[ -z "$(tail -c1 "$DIR/.env")" ] || echo >> "$DIR/.env"   # fehlenden Zeilenumbruch am Dateiende heilen
grep -q '^U1_CHAT_BOT_INGEST_SECRET=' "$DIR/.env" \
  || printf 'U1_CHAT_BOT_INGEST_SECRET=%s\n' "$(cat "$SECRET_FILE")" >> "$DIR/.env" \
  || rollback ".env secret append"
grep -q '^U1_CHAT_EXTRA_EMAILS=' "$DIR/.env" \
  || printf 'U1_CHAT_EXTRA_EMAILS=dirk.jedlitschka@idolz.com\n' >> "$DIR/.env" \
  || rollback ".env extra-emails append"
# Diktat: Operator-Key der transcribe-api übernehmen (Wert wird NIE ausgegeben);
# fehlt er, bleibt /api/transcribe auf 503 und die Clients blenden Diktat aus.
if ! grep -q '^U1_CHAT_TRANSCRIBE_KEY=' "$DIR/.env"; then
  TK="$(docker exec transcribe-api printenv TRANSCRIBE_API_KEY 2>/dev/null || true)"
  if [ -n "$TK" ]; then
    printf 'U1_CHAT_TRANSCRIBE_KEY=%s\n' "$TK" >> "$DIR/.env" || rollback ".env transcribe-key append"
    echo "✅ (e) U1_CHAT_TRANSCRIBE_KEY aus transcribe-api übernommen"
  else
    echo "⚠️ (e) TRANSCRIBE_API_KEY nicht ermittelbar — Diktat bleibt deaktiviert (503)"
  fi
fi
echo "✅ (e) .env-Keys vorhanden/ergänzt"
# (f) Restart
systemctl --user restart unitone-chat || rollback "restart"
sleep 3
systemctl --user is-active --quiet unitone-chat || rollback "service nicht aktiv"
echo "✅ (f) unitone-chat aktiv"
# (g) Health
H1=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/)
[ "$H1" = "302" ] || rollback "GET / lieferte $H1 (erwartet 302)"
H2=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/api/bots)
[ "$H2" = "401" ] || rollback "GET /api/bots unauth lieferte $H2 (erwartet 401)"
rm -rf "$TMP"
echo "✅ (g) Health OK: GET / => 302 · GET /api/bots (unauth) => 401"
echo "✅ DEPLOY FERTIG (Backup: server.ts/db.ts.bak-messenger-$STAMP)"
REMOTE

echo
echo "→ Nächster Schritt: ./bridge.sh (tg-send app:-Branch + CLAUDE.md-Regeln, kein Restart nötig)"
