#!/bin/bash
# auth-widening.sh — GATED: subunit-auth SSO-App "u1-chat" für Dirks externe Email öffnen.
#
# ⛔️ NICHT ohne TJ-Go ausführen — restartet subunit-auth (zentraler Auth-Dienst ALLER Apps).
#
# Kontext (verifiziert am Live-Code src/sso.ts, 237 Zeilen, read-only gelesen 2026-07-02):
#   - u1-chat ist in SSO_APPS als access:"verified" + allowedDomain:"subunit.ai" registriert.
#   - Das Gate sitzt in accessDenied(): verified + allowedDomain → endsWith-Check → "wrong_domain".
#   - Es gibt KEINEN bestehenden extra-Email-Mechanismus (nur allowedWorkspaces für operator-Apps,
#     das greift bei access:"verified" nicht) → kleinstmöglicher additiver Eingriff:
#     optionales `extraEmails`-Feld im SsoApp-Interface + u1-chat-Eintrag + ein Zusatz-Term im
#     accessDenied-Check. Andere Apps bleiben byte-identisch im Verhalten.
#
# Nur nötig für iOS/Web-SSO-Login von Dirk. Der Desktop-Bearer-Weg braucht das NICHT
# (u1-chat prüft den JWT selbst via emailAllowed). Dirk braucht zusätzlich einen
# auth.subunit.ai-Account mit verifizierter Email (Provisionierung separat).
#
# Backup + bun-build-Check + Auto-Rollback + Health. Idempotent (Marker: extraEmails).
# AUSFÜHREN (vom Mac, NACH TJ-Go): ./auth-widening.sh
set -euo pipefail
SRV_HOST=subunit-server

# Hartes Gate — NICHT nur Kommentar. Restartet subunit-auth (zentraler Dienst ALLER Apps).
# Interaktiv "DEPLOY" tippen, oder non-interaktiv CONFIRM=DEPLOY ./auth-widening.sh.
if [ "${CONFIRM:-}" != "DEPLOY" ]; then
  if [ -t 0 ]; then
    read -r -p "⛔️ Widening restartet den ZENTRALEN Auth-Dienst (auth.subunit.ai). Tippe DEPLOY zum Fortfahren: " ANS
    [ "$ANS" = "DEPLOY" ] || { echo "Abgebrochen."; exit 1; }
  else
    echo "⛔️ Gate: non-interaktiv mit CONFIRM=DEPLOY ./auth-widening.sh ausführen."; exit 1
  fi
fi

ssh "$SRV_HOST" bash -s <<'REMOTE'
set -euo pipefail
STAMP=$(date +%Y%m%d-%H%M%S)
DIR="$HOME/subunit/unitone/workspace/projects/subunit-auth"
SSO="$DIR/src/sso.ts"
BUN="$(command -v bun || echo "$HOME/.bun/bin/bun")"
[ -f "$SSO" ] || { echo "❌ sso.ts nicht gefunden: $SSO"; exit 1; }

if grep -q "extraEmails" "$SSO"; then
  echo "ℹ️  extraEmails bereits vorhanden — keine Änderung"; exit 0
fi
cp "$SSO" "$SSO.bak-messenger-$STAMP"
echo "✅ Backup: sso.ts.bak-messenger-$STAMP"

python3 - "$SSO" <<'PY'
import sys
p = sys.argv[1]; s = open(p, encoding="utf-8").read()

# 1) Interface: optionales extraEmails-Feld (Anker = extraScopes-Zeile, existiert 1x)
i_anchor = '  extraScopes?: string[]; // zusätzliche Scopes im Access-Token dieser App (z.B. meet → "transcribe"; TJ 2026-06-13)'
assert s.count(i_anchor) == 1, "Interface-Anker (extraScopes) nicht eindeutig"
s = s.replace(i_anchor, i_anchor + '''
  extraEmails?: string[]; // bei access==="verified": zusätzlich erlaubte externe Emails (lowercased; Dirk/u1-chat, TJ 2026-07)''')

# 2) u1-chat-App-Eintrag (Anker eindeutig über redirectPrefixes — synapse hat denselben
#    verified/allowedDomain-Block, daher NICHT nur darauf ankern)
a_anchor = '''    redirectPrefixes: ["https://chat.subunit.ai/", "http://localhost:3000/", "subunit://auth/callback"],
    access: "verified",
    allowedDomain: "subunit.ai",'''
assert s.count(a_anchor) == 1, "u1-chat-App-Anker nicht eindeutig"
s = s.replace(a_anchor, a_anchor + '''
    extraEmails: ["dirk.jedlitschka@idolz.com"],''')

# 3) accessDenied: extraEmails vor dem wrong_domain-Verdikt zulassen
g_anchor = '  if (app.access === "verified" && app.allowedDomain && !email.endsWith("@" + app.allowedDomain)) return "wrong_domain";'
assert s.count(g_anchor) == 1, "accessDenied-Anker nicht eindeutig"
s = s.replace(g_anchor, '''  if (app.access === "verified" && app.allowedDomain && !email.endsWith("@" + app.allowedDomain)
    && !(app.extraEmails || []).includes(email)) return "wrong_domain";''')

open(p, "w", encoding="utf-8").write(s)
print("✅ sso.ts: extraEmails-Feld + u1-chat-Eintrag + accessDenied-Check")
PY

echo "=== bun-build-Check ==="
cd "$DIR"
if ! "$BUN" build --target=bun ./src/server.ts >/dev/null 2>/tmp/auth-widen-$STAMP.err; then
  echo "❌ Build fehlgeschlagen — ROLLBACK (Dienst lief die ganze Zeit unverändert weiter):"
  head -30 "/tmp/auth-widen-$STAMP.err"
  cp "$SSO.bak-messenger-$STAMP" "$SSO"
  exit 1
fi
echo "✅ bun build OK"

echo "=== Restart subunit-auth + Health ==="
systemctl --user restart subunit-auth
sleep 3
if ! systemctl --user is-active --quiet subunit-auth; then
  echo "❌ Service nicht aktiv — ROLLBACK"
  cp "$SSO.bak-messenger-$STAMP" "$SSO"
  systemctl --user restart subunit-auth; sleep 3
  echo "   Rollback-Service: $(systemctl --user is-active subunit-auth)"
  exit 1
fi
# WICHTIG: curl-Exit abfangen (|| echo 000) — sonst killt set -e die Zuweisung, falls der
# Dienst nach dem Restart nicht lauscht, und der Rollback-Pfad wird nie erreicht.
JWKS=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:7841/.well-known/jwks.json || echo 000)
if [ "$JWKS" != "200" ]; then
  echo "❌ Health fehlgeschlagen (jwks => $JWKS) — ROLLBACK"
  cp "$SSO.bak-messenger-$STAMP" "$SSO"
  systemctl --user restart subunit-auth; sleep 3
  echo "   Rollback-Health jwks: $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:7841/.well-known/jwks.json || echo 000)"
  exit 1
fi
echo "✅ subunit-auth aktiv, jwks => 200 (Backup: sso.ts.bak-messenger-$STAMP)"
echo "   Dirks Web/iOS-SSO für u1-chat ist jetzt zugelassen (Account-Provisionierung separat prüfen)."
REMOTE
