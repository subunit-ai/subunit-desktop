#!/usr/bin/env bash
# deploy/sni-live/deploy.sh — Stufe 2 der Zentrale: SNI (sni.subunit.ai) akzeptiert
# den first-party-Bearer des Subunit-Desktop + CORS für tauri://localhost.
#
# Sicher by design:
#   • Image-Snapshot-Backup (docker commit sni sni-rollback:<ts>) + .bak-Dateien
#   • idempotenter Patch (mehrfach ausführbar = No-Op)
#   • node --check-Syntax-Gate vor dem Rebuild
#   • Health- + Gate- + CORS-Verifikation nach dem Rebuild
#   • Auto-Rollback bei JEDEM Fehler (Dateien zurück + rebuild)
#
# Nur die Auth-/CORS-Zeilen ändern sich; Blast-Radius = allein der sni-Container.
#
# Ausführen (vom Mac, aus dem Repo-Root):
#     ! bash deploy/sni-live/deploy.sh
#
# Overrides: SNI_SERVER (default subunit-server), SNI_DIR, ENGINE_DIR.
set -euo pipefail

SERVER="${SNI_SERVER:-subunit-server}"
HERE="$(cd "$(dirname "$0")" && pwd)"

echo "▶ SNI-Live-Deploy → $SERVER"
echo "· lade Patcher hoch …"
scp -q "$HERE/patch.mjs" "$SERVER:/tmp/sni-patch.mjs"

# Der gesamte riskante Teil läuft atomar auf dem Server mit Auto-Rollback.
ssh -o ConnectTimeout=15 "$SERVER" 'bash -s' <<'REMOTE'
set -euo pipefail
: "${SNI_DIR:=$HOME/Documents/SNI}"
: "${ENGINE_DIR:=$HOME/subunit/subunit-engine}"
TS="$(date +%Y%m%d-%H%M%S)"
cd "$SNI_DIR"

echo "· Backup: docker commit sni sni-rollback:$TS + .bak"
docker commit sni "sni-rollback:$TS" >/dev/null
cp auth.js "auth.js.bak.$TS"
cp server.js "server.js.bak.$TS"

rollback() {
  echo "✗ FEHLER erkannt — rolle zurück auf Stand vor $TS …"
  cp "auth.js.bak.$TS" auth.js
  cp "server.js.bak.$TS" server.js
  (cd "$ENGINE_DIR" && docker compose build sni && docker compose up -d sni) || docker start sni || true
  echo "↩ zurückgerollt. Image-Snapshot bleibt als Netz: sni-rollback:$TS"
  exit 1
}
trap rollback ERR

echo "· patche auth.js + server.js (idempotent) …"
node /tmp/sni-patch.mjs "$SNI_DIR"

echo "· Syntax-Gate (node --check) …"
node --check auth.js
node --check server.js

echo "· rebuild + restart sni …"
cd "$ENGINE_DIR"
docker compose build sni
docker compose up -d sni

echo "· warte auf Health (max ~40s) …"
code=000
for _ in $(seq 1 20); do
  code="$(curl -fsS -m 5 -o /dev/null -w '%{http_code}' https://sni.subunit.ai/api/health 2>/dev/null || echo 000)"
  [ "$code" = "200" ] && break
  sleep 2
done
[ "$code" = "200" ] || { echo "Health nie 200 (letzter: $code)"; false; }

echo "· verifiziere Auth-Gate (gpu ohne Auth MUSS 401 bleiben) …"
gpu="$(curl -sS -m 6 -o /dev/null -w '%{http_code}' https://sni.subunit.ai/api/gpu 2>/dev/null || echo 000)"
[ "$gpu" = "401" ] || { echo "gpu ohne Auth erwartet 401, war $gpu — Gate wäre kaputt!"; false; }

echo "· verifiziere CORS (ACAO für tauri://localhost) …"
acao="$(curl -sS -m 6 -D - -o /dev/null -X OPTIONS https://sni.subunit.ai/api/gpu \
  -H 'Origin: tauri://localhost' -H 'Access-Control-Request-Method: GET' 2>/dev/null \
  | tr -d '\r' | grep -i '^access-control-allow-origin:' || true)"
echo "  → ${acao:-<kein ACAO-Header>}"
case "$acao" in *tauri://localhost*|*'*'*) : ;; *) echo "Kein ACAO für tauri://localhost"; false ;; esac

trap - ERR
echo ""
echo "✅ SNI LIVE: health=200 · gpu-ohne-Auth=401 (Gate intakt) · CORS tauri://localhost gesetzt."
echo "   Manueller Rollback (falls je nötig):"
echo "     cp $SNI_DIR/auth.js.bak.$TS $SNI_DIR/auth.js"
echo "     cp $SNI_DIR/server.js.bak.$TS $SNI_DIR/server.js"
echo "     (cd $ENGINE_DIR && docker compose build sni && docker compose up -d sni)"
REMOTE

echo ""
echo "✅ Server steht. Desktop-Seite ist bereits verdrahtet (CSP + sni-api-Client + Live/Demo-Badge)."
echo "   → SNI-Tabs im Subunit-Desktop ziehen ab jetzt echte Daten."
