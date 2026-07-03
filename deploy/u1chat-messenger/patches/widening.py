# widening.py — emailAllowed()-Widening (CONTRACT-messenger.md A.3).
# u1-chat-Domain-Gate wird zu: endsWith @ALLOWED_DOMAIN ODER Email ∈ U1_CHAT_EXTRA_EMAILS
# (default dirk.jedlitschka@idolz.com). Gates: SSO-Callback, Bearer-Lane, Team-Member-Checks
# (DM-Target, Gruppen-Member-Filter, groups-Welle /members/add). authLogin() ist toter Code
# (keine Route ruft ihn) und bleibt bewusst unangetastet. NACH allen Wellen anwenden
# (der /members/add-Check existiert erst nach der groups-Welle).
import sys
srv_p = sys.argv[1]
srv = open(srv_p, encoding="utf-8").read()

if "emailAllowed" in srv:
    print("ℹ️  emailAllowed bereits vorhanden — keine Änderung"); sys.exit(0)

# 1) Helper direkt nach ALLOWED_DOMAIN
dom_anchor = 'const ALLOWED_DOMAIN = (process.env.U1_CHAT_DOMAIN || "subunit.ai").toLowerCase();'
assert srv.count(dom_anchor) == 1, "ALLOWED_DOMAIN-Anker nicht eindeutig"
srv = srv.replace(dom_anchor, dom_anchor + '''
// Zugangs-Gate: @subunit.ai ODER explizit freigeschaltete externe Emails (z. B. Dirk).
const EXTRA_EMAILS = new Set(csv(process.env.U1_CHAT_EXTRA_EMAILS || "dirk.jedlitschka@idolz.com").map((e) => e.toLowerCase()));
function emailAllowed(email: string): boolean {
  return email.endsWith("@" + ALLOWED_DOMAIN) || EXTRA_EMAILS.has(email);
}''')

# 2) Gate: SSO-Callback (Domaincheck)
g1_old = 'if (!claims.email_verified || !email.endsWith("@" + ALLOWED_DOMAIN)) return failRedirect("domain");'
assert srv.count(g1_old) == 1, "SSO-Callback-Gate-Anker nicht eindeutig"
srv = srv.replace(g1_old, 'if (!claims.email_verified || !emailAllowed(email)) return failRedirect("domain");')

# 3) Gate: Bearer-Lane (Domaincheck)
g2_old = 'if (claims && claims.email_verified && bemail.endsWith("@" + ALLOWED_DOMAIN)) {'
assert srv.count(g2_old) == 1, "Bearer-Lane-Gate-Anker nicht eindeutig"
srv = srv.replace(g2_old, 'if (claims && claims.email_verified && emailAllowed(bemail)) {')

# 4) Gate: Team-DM-Target
g3_old = 'if (!target.endsWith("@" + ALLOWED_DOMAIN) || target === sess.email) return json({ error: "invalid_target" }, 400);'
assert srv.count(g3_old) == 1, "Team-DM-Target-Anker nicht eindeutig"
srv = srv.replace(g3_old, 'if (!emailAllowed(target) || target === sess.email) return json({ error: "invalid_target" }, 400);')

# 5) Gate: Gruppen-Erstellung Member-Filter
g4_old = 'raw.filter((m: string) => m.endsWith("@" + ALLOWED_DOMAIN))'
assert srv.count(g4_old) == 1, "Gruppen-Member-Filter-Anker nicht eindeutig"
srv = srv.replace(g4_old, 'raw.filter((m: string) => emailAllowed(m))')

# 6) Gate: groups-Welle /members/add
g5_old = 'if (!email.endsWith("@" + ALLOWED_DOMAIN)) return json({ error: "invalid_target" }, 400);'
assert srv.count(g5_old) == 1, "members/add-Gate-Anker nicht eindeutig"
srv = srv.replace(g5_old, 'if (!emailAllowed(email)) return json({ error: "invalid_target" }, 400);')

# Verifikation: außer im toten authLogin() darf kein Domain-endsWith-Gate mehr existieren
rest = srv.count('.endsWith("@" + ALLOWED_DOMAIN)')
assert rest == 2, f"unerwartete Rest-Vorkommen von endsWith-Gates: {rest} (erwartet 2: emailAllowed selbst + authLogin toter Code)"

open(srv_p, "w", encoding="utf-8").write(srv)
print("✅ server.ts: emailAllowed() + 5 Gates gewidet (SSO/Bearer/DM/Gruppen/members-add); authLogin (tot) unangetastet")
