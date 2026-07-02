// patch.mjs — idempotenter SNI-Live-Access-Patch (Stufe 2 der Zentrale).
//
// Macht sni.subunit.ai für den Subunit-Desktop erreichbar, OHNE das Sicherheits-
// modell aufzuweichen:
//   1) auth.js requireAuth: sync → async + ein Bearer-Zweig, der das EXAKTE
//      SSO-Operator-Gate repliziert (verifiedJwtClaims prüft RS256-Signatur,
//      iss, aud=first-party, exp/nbf; danach email_verified + @ALLOWED_DOMAIN +
//      REQUIRE_OPERATOR→op===true — 1:1 wie der /api/auth/callback-Pfad).
//   2) ALLOWED_ORIGINS (auth.js) + CORS_ORIGINS (server.js): + 'tauri://localhost'.
//
// Idempotent: mehrfaches Ausführen ist ein No-Op. Bricht laut ab, wenn ein
// erwarteter Anker fehlt (dann NICHT schreiben — der Aufrufer rollt zurück).
//
// Usage:  node patch.mjs <SNI_DIR>
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: node patch.mjs <SNI_DIR>");
  process.exit(2);
}

const authPath = join(dir, "auth.js");
const serverPath = join(dir, "server.js");
const changed = [];
const fatal = (m) => {
  console.error("FATAL: " + m);
  process.exit(3);
};

// ── auth.js ────────────────────────────────────────────────────────────────
let auth = readFileSync(authPath, "utf8");

// 1) requireAuth sync → async (nur wenn noch nicht async).
if (auth.includes("export function requireAuth(")) {
  auth = auth.replace("export function requireAuth(", "export async function requireAuth(");
  changed.push("auth: requireAuth → async");
} else if (!auth.includes("export async function requireAuth(")) {
  fatal("requireAuth export nicht gefunden in auth.js");
}

// 2) Bearer-Zweig direkt nach dem OPEN_PATHS-Guard injizieren (idempotent).
if (!auth.includes("// [sni-live] Bearer")) {
  const anchor = "if (OPEN_PATHS.has(req.path)) return next();";
  if (!auth.includes(anchor)) fatal("OPEN_PATHS-Anker nicht gefunden in auth.js");
  const branch =
    anchor +
    `
  // [sni-live] Bearer (first-party JWT) — Desktop/programmatischer Zugriff.
  // Repliziert das SSO-Operator-Gate 1:1 (siehe /api/auth/callback).
  {
    const authz = req.headers["authorization"] || req.headers["Authorization"] || "";
    if (authz.startsWith("Bearer ")) {
      try {
        const claims = await verifiedJwtClaims(authz.slice(7).trim());
        const email = String((claims && claims.email) || "").toLowerCase();
        if (!claims || !claims.email_verified || !email.endsWith("@" + ALLOWED_DOMAIN)) {
          return res.status(401).json({ error: "unauthorized" });
        }
        if (REQUIRE_OPERATOR && claims.op !== true) {
          return res.status(403).json({ error: "forbidden" });
        }
        req.sniUser = { email, op: claims.op === true };
        return next();
      } catch {
        return res.status(401).json({ error: "unauthorized" });
      }
    }
  }`;
  auth = auth.replace(anchor, branch);
  changed.push("auth: Bearer-Zweig injiziert");
}

// 3) ALLOWED_ORIGINS + 'tauri://localhost'.
if (!auth.includes("'tauri://localhost'")) {
  const a2 = "export const ALLOWED_ORIGINS = new Set([\n  'https://sni.subunit.ai',";
  if (!auth.includes(a2)) fatal("ALLOWED_ORIGINS-Anker nicht gefunden in auth.js");
  auth = auth.replace(a2, a2 + "\n  'tauri://localhost',");
  changed.push("auth: ALLOWED_ORIGINS + tauri://localhost");
}

writeFileSync(authPath, auth);

// ── server.js ────────────────────────────────────────────────────────────────
let server = readFileSync(serverPath, "utf8");
if (!server.includes("'tauri://localhost'")) {
  const s1 = "const CORS_ORIGINS = ['https://sni.subunit.ai',";
  if (!server.includes(s1)) fatal("CORS_ORIGINS-Anker nicht gefunden in server.js");
  server = server.replace(s1, "const CORS_ORIGINS = ['https://sni.subunit.ai', 'tauri://localhost',");
  changed.push("server: CORS_ORIGINS + tauri://localhost");
}
writeFileSync(serverPath, server);

console.log(changed.length ? "PATCHED:\n - " + changed.join("\n - ") : "NOOP (bereits gepatcht)");
