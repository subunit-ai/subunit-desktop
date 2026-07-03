#!/bin/bash
# bridge.sh — Server-Betriebsapparat für den App-Kanal (Contract C, ADDITIV, KEIN Service-Restart).
#   (1) Secret-Erzeugung falls fehlt (uuidgen ohne Bindestriche, chmod 600)
#   (2) tg-send: app:-Branch direkt nach dem Empty-Text-Check (idempotent per Marker SUBUNIT-APP-CHANNEL);
#       Telegram-Pfad bleibt byte-identisch.
#   (3) CLAUDE.md-Regel mit Marker <!-- SUBUNIT-APP-CHANNEL --> in alle 4 Bot-Workdirs
#       (Haupt + units/{group,erik,dirk}), idempotent.
#
# Reihenfolge: NACH ./deploy.sh (Routen + Secret in .env müssen live sein, sonst läuft
# tg-send app:… gegen 404/401). Läuft aber auch davor ohne Schaden (nur Ingest schlägt fehl).
# AUSFÜHREN (vom Mac): ./bridge.sh
set -euo pipefail
SRV_HOST=subunit-server

ssh "$SRV_HOST" bash -s <<'REMOTE'
set -euo pipefail
STAMP=$(date +%Y%m%d-%H%M%S)
TGSEND="$HOME/.config/unitone/bin/tg-send"
[ -f "$TGSEND" ] || { echo "❌ tg-send nicht gefunden: $TGSEND"; exit 1; }

# --- (1) Secret erzeugen falls fehlt (idempotent, identisch zu deploy.sh) ---
SECRET_FILE="$HOME/.config/unitone/bot-ingest-secret"
if [ ! -s "$SECRET_FILE" ]; then
  mkdir -p "$(dirname "$SECRET_FILE")"
  (umask 177 && uuidgen | tr -d '-' > "$SECRET_FILE")
  chmod 600 "$SECRET_FILE"
  echo "✅ bot-ingest-secret erzeugt (0600) — deploy.sh trägt ihn in die u1-chat .env"
else
  echo "ℹ️  bot-ingest-secret existiert bereits"
fi

# --- (2) tg-send: app:-Branch (idempotent per Marker) ---
if grep -q "SUBUNIT-APP-CHANNEL" "$TGSEND"; then
  echo "ℹ️  tg-send: app:-Branch bereits vorhanden (Marker gefunden)"
else
  cp "$TGSEND" "$TGSEND.bak-messenger-$STAMP"
  python3 - "$TGSEND" <<'PY'
import sys
p = sys.argv[1]; s = open(p, encoding="utf-8").read()
anchor = 'if not text.strip():\n    die("leerer text")'
assert s.count(anchor) == 1, "tg-send-Anker (Empty-Text-Check) nicht eindeutig"
branch = anchor + '''

# SUBUNIT-APP-CHANNEL: app:-chat_ids gehen NICHT an Telegram, sondern an den u1-chat-Loopback-Ingest.
# Telegram-Pfad darunter bleibt byte-identisch.
if chat_id.startswith("app:"):
    import json
    try:
        secret = open(os.path.expanduser("~/.config/unitone/bot-ingest-secret")).read().strip()
    except OSError:
        die("kein bot-ingest-secret")
    payload = json.dumps({"secret": secret, "chat_id": chat_id, "text": text}).encode()
    rq = urllib.request.Request("http://127.0.0.1:3000/internal/bot-reply", data=payload,
                                headers={"content-type": "application/json"})
    try:
        with urllib.request.urlopen(rq, timeout=15) as resp:
            ok = json.load(resp).get("ok")
            print("app-sent" if ok else "app-fehler"); sys.exit(0 if ok else 1)
    except Exception as e:
        die("app-send fehlgeschlagen: %s" % e)'''
s = s.replace(anchor, branch)
open(p, "w", encoding="utf-8").write(s)
print("✅ tg-send: app:-Branch eingefügt")
PY
  if python3 -c "import ast; ast.parse(open('$TGSEND').read())"; then
    echo "✅ tg-send Syntax OK (Backup: $TGSEND.bak-messenger-$STAMP)"
  else
    echo "❌ tg-send Syntax kaputt — ROLLBACK"
    cp "$TGSEND.bak-messenger-$STAMP" "$TGSEND"
    exit 1
  fi
fi

# --- (3) CLAUDE.md-Regel in alle 4 Bot-Workdirs (idempotent per Marker) ---
for MD in "$HOME/subunit/unitone/CLAUDE.md" \
          "$HOME/subunit/unitone/units/group/CLAUDE.md" \
          "$HOME/subunit/unitone/units/erik/CLAUDE.md" \
          "$HOME/subunit/unitone/units/dirk/CLAUDE.md"; do
  if [ ! -f "$MD" ]; then echo "⚠️  fehlt (übersprungen): $MD"; continue; fi
  if grep -q "SUBUNIT-APP-CHANNEL" "$MD"; then echo "ℹ️  Regel schon da: $MD"; continue; fi
  cp "$MD" "$MD.bak-messenger-$STAMP"
  cat >> "$MD" <<'MD_RULE'

<!-- SUBUNIT-APP-CHANNEL -->
## Subunit-App-Kanal (zusätzlich zu Telegram)
Nachrichten mit `<channel source="app" chat_id="app:…">` IMMER via
`tg-send '<chat_id>' "<text>"` beantworten (den `app:…`-chat_id aus dem Tag zurückgeben —
das reply-MCP-Tool lehnt `app:`-IDs per Allowlist ab). Gleiche Persona wie Telegram.
Im Gruppen-Raum steht der Absender im `user=`-Attribut des Tags.
MD_RULE
  echo "✅ Regel ergänzt: $MD (Backup -messenger-$STAMP)"
done

echo
echo "✅ Bridge fertig (kein Service-Restart nötig)."
echo "   Hinweis: Der reply_hint im injizierten Tag wirkt sofort — die CLAUDE.md-Regel greift in"
echo "   laufenden Sessions erst nach /compact bzw. Session-Neustart (nur für Dauerhaftigkeit)."
REMOTE
