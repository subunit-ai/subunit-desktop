# SNI Live-Access — Stufe 2 der Zentrale

Macht **sni.subunit.ai** für den Subunit-Desktop erreichbar, ohne das Sicherheits­modell
aufzuweichen. Danach ziehen die SNI-Tabs (Cortex/Home/Network/Reflexe/Security) echte
Server-Daten statt Mock.

## Ausführen

Aus dem Repo-Root:

```
! bash deploy/sni-live/deploy.sh
```

Das ist die einzige Aktion, die nur **TJ** auslösen kann — ein Production-Deploy des
geteilten sni-Containers (u1 darf im Auto-Mode keine Server-Rebuilds fahren). Das Script
ist so gebaut, dass „ausführen" trivial und sicher ist.

## Was es tut

1. **Backup** — `docker commit sni sni-rollback:<ts>` (voller Image-Snapshot) + `.bak`
   von `auth.js`/`server.js`.
2. **Patch** (`patch.mjs`, idempotent):
   - `auth.js` `requireAuth`: `sync → async` + ein **Bearer-Zweig**, der das exakte
     SSO-Operator-Gate repliziert — `verifiedJwtClaims` (RS256/JWKS-Signatur, `iss`,
     `aud=first-party`, `exp/nbf`), danach `email_verified` + `@ALLOWED_DOMAIN` +
     `REQUIRE_OPERATOR → op===true`. **Kein neues Auth-Konstrukt**, nur der vorhandene,
     gehärtete Verifier — 1:1 wie `/api/auth/callback`.
   - `ALLOWED_ORIGINS` (auth.js) + `CORS_ORIGINS` (server.js): `+ 'tauri://localhost'`.
3. **Syntax-Gate** — `node --check` auf beide Dateien vor dem Rebuild.
4. **Rebuild** — `docker compose build sni && up -d sni` (Dockerfile `COPY`t auth.js +
   server.js → Patch wird ins Image gebacken; Frontend-`dist/` bleibt unangetastet).
5. **Verifikation** — health=200 · `gpu` ohne Auth = 401 (Gate beweisbar intakt) ·
   ACAO-Header für `tauri://localhost`.
6. **Auto-Rollback** — bei JEDEM Fehlschlag: `.bak` zurück + rebuild. Der Image-Snapshot
   bleibt zusätzlich als Netz.

Blast-Radius = allein der `sni`-Container, sekundenweise, vollständig reversibel.

## Manueller Rollback

Das Script druckt am Ende die exakten Befehle. Grundmuster:

```
cp ~/Documents/SNI/auth.js.bak.<ts>   ~/Documents/SNI/auth.js
cp ~/Documents/SNI/server.js.bak.<ts> ~/Documents/SNI/server.js
cd ~/subunit/subunit-engine && docker compose build sni && docker compose up -d sni
```

## Desktop-Gegenstück

Die Client-Seite ist bereits im Repo verdrahtet:
- `src-tauri/tauri.conf.json` — CSP `connect-src` erlaubt `https://sni.subunit.ai`.
- `src/lib/sni.ts` — typisierter sni-api-Client über `host.backend.fetch('sni-api', …)`
  mit Live→Demo-Fallback (kein Crash, wenn der Server (noch) nicht erreichbar ist).

Sobald der Server steht, schalten die Tabs automatisch von „Demo" auf „Live".
