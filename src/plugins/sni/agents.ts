/**
 * agents.ts — the SNI registry (the "nervous system").
 *
 * MODEL (per TJ): there is exactly ONE agent — U1 — and you add SKILLS to it.
 * The former "specialist agents" S-01…S-11 are now U1's SKILLS, each carrying a
 * status/load (cpu/mem), AXONE (connections to other skills) and REFLEXE
 * (automatic triggers). The Cortex view renders U1 at the core with its skills
 * around it; `axone` codes reference other skills' `code`.
 *
 * Internally each entry still uses the `Agent` shape (one orchestrator flag marks
 * U1) so the existing neural-map math is reused — but everything user-facing says
 * "Skill". `skillsOf()` returns the skills; `orchestratorOf()` returns U1.
 */

export type Tier = "surface" | "core" | "deep";
export type AgentStatus = "running" | "idle" | "stopped" | "error";

export interface Agent {
  id: string;
  name: string;
  code: string; // e.g. "U1", "S-01"
  role: string;
  tier: Tier;
  color: string; // hex accent
  status: AgentStatus;
  cpu: number; // %
  mem: number; // MB
  desc: string;
  axone: string[]; // codes of connected agents
  reflexe: string[]; // trigger names
  /** The single orchestrator (the brain). Views pick it by THIS flag, never by a
   *  hardcoded "U1" — the S-01..S-12 roster is a seed and will be redefined. */
  orchestrator?: boolean;
}

/** The one orchestrator agent (by flag, with a code fallback) — this is U1. */
export const orchestratorOf = (agents: Agent[]): Agent | undefined =>
  agents.find((a) => a.orchestrator) ?? agents.find((a) => a.code === "U1");

/** U1's SKILLS = every registry entry that is not the orchestrator. */
export const skillsOf = (agents: Agent[]): Agent[] => agents.filter((a) => !a.orchestrator);

/** A skill U1 can be given that isn't active yet — the skill marketplace. */
export interface AvailableSkill {
  code: string;
  name: string;
  emoji: string;
  category: Tier;
  desc: string;
  abilities: string[];
  price: string;
  status: "ready" | "available" | "development" | "planned";
}

/** Skills U1 doesn't have yet (ported from the SNI marketplace catalogue). */
export const AVAILABLE_SKILLS: AvailableSkill[] = [
  { code: "SK-ARC", name: "Architect", emoji: "🏗️", category: "core", status: "ready", price: "349€/mo", desc: "Automatisches n8n-Workflow-Deployment, Axon-Builder, Infrastructure-as-Code für neue Skills.", abilities: ["n8n Auto-Deploy", "Axon-Builder", "Infrastructure-as-Code"] },
  { code: "SK-LIB", name: "Librarian", emoji: "📚", category: "surface", status: "planned", price: "149€/mo", desc: "Workspace-Organisation, automatische Archivierung, Dokumenten-Lifecycle.", abilities: ["Auto-Archivierung", "Tag-System", "Retention"] },
  { code: "SK-SYN", name: "Sync", emoji: "🔄", category: "surface", status: "planned", price: "149€/mo", desc: "Automatische Datensynchronisation zwischen allen Axonen — CRM, Mail, Kalender, Wissen.", abilities: ["Bi-direktionaler Sync", "Conflict Resolution", "Delta-Updates"] },
  { code: "SK-XX", name: "Custom Skill", emoji: "⚙️", category: "deep", status: "available", price: "Auf Anfrage", desc: "Maßgeschneiderter Skill nach deinen Anforderungen — wir bauen, was dein Business braucht.", abilities: ["Individuelles Design", "Custom-API", "SLA-Garantie"] },
];

/**
 * Tier presentation config — label + accent + ring radius. Data-driven so a 4th
 * tier or a rename is a one-line change, not a code edit (SNI-PLAN §5.3).
 */
export const TIER_CONFIG: Record<Tier, { label: string; color: string; ring: number }> = {
  core: { label: "Core", color: "#06b6d4", ring: 150 },
  surface: { label: "Surface", color: "#ff8a5b", ring: 238 },
  deep: { label: "Deep", color: "#2dd4bf", ring: 318 },
};

export const AGENTS: Agent[] = [
  {
    id: "u1", name: "Unit One", code: "U1", role: "Orchestrator", tier: "core",
    color: "#00f0ff", status: "running", cpu: 12, mem: 340, orchestrator: true,
    desc: "Claude Opus — der eine Orchestrator. Einziger Router des Agent-Mesh (One-Hop), koordiniert alle Skills, routet Aufgaben, überwacht den Systemzustand.",
    axone: ["GEM", "CDX", "JUL", "MEM", "MEE", "RES", "CST", "MON", "VOX", "DSG", "PLS", "BRG"],
    reflexe: ["Routing-Advisor", "Self-Healing", "Health-Check", "Pulse", "Reflect"],
  },
  // ── Code-AI-Mesh (U1's Worker — die echten Sub-AIs) ──
  {
    id: "gem", name: "Gemini", code: "GEM", role: "Analyse & Web-Grounding", tier: "core",
    color: "#4285f4", status: "running", cpu: 9, mem: 260,
    desc: "1M-Kontext-Analyse, Root-Cause, Web-Grounding, Brainstorm — zweite Stimme im Review-Panel. Reflex: gemini-consult.sh.",
    axone: ["U1", "CDX", "JUL", "RES"],
    reflexe: ["Gemini-Consult", "Web-Grounding"],
  },
  {
    id: "cdx", name: "Codex", code: "CDX", role: "Security-Review & Writes", tier: "deep",
    color: "#10a37f", status: "running", cpu: 7, mem: 230,
    desc: "Security-/Adversarial-Review, lokale Writes (auch Non-Git), Root-Cause. Reflex: /codex:review, codex-companion.",
    axone: ["U1", "GEM", "JUL"],
    reflexe: ["Codex-Review", "Adversarial-Scan"],
  },
  {
    id: "jul", name: "Jules", code: "JUL", role: "Async Cloud-Implementierung", tier: "core",
    color: "#fbbc05", status: "idle", cpu: 0, mem: 90,
    desc: "Async Cloud-Implementierung auf GitHub-Repos, Multi-File-Refactors, parallel, 0 lokales RAM. Reflex: jules-task.sh.",
    axone: ["U1", "GEM", "CDX"],
    reflexe: ["Jules-Task"],
  },
  // ── Capability-Skills (echte Reflexe/Scripts) ──
  {
    id: "mem", name: "Memory", code: "MEM", role: "Vektor-Wissen (RAG)", tier: "core",
    color: "#fbbf24", status: "running", cpu: 14, mem: 480,
    desc: "RAG-Vektorgedächtnis (ChromaDB · bge-m3) via Memory-Agent: Ingest & semantische Suche. Reflexe: vector-ingest/search, memory-index-guard, memory-ingest-smart.",
    axone: ["U1", "RES", "MEE"],
    reflexe: ["Memory-Ingest", "Index-Guard", "Vector-Search"],
  },
  {
    id: "mee", name: "Meet", code: "MEE", role: "Meeting-Intelligenz", tier: "surface",
    color: "#38bdf8", status: "running", cpu: 11, mem: 300,
    desc: "Post-Meeting-Aktionen u1-side: Diarization, Sprecher-Trennung, Voiceprint-Match. Reflex: meet-intelligence.sh (alle 2 Min).",
    axone: ["U1", "MEM", "VOX"],
    reflexe: ["Meet-Intelligence"],
  },
  {
    id: "res", name: "Research", code: "RES", role: "Deep & Web-Research", tier: "core",
    color: "#c084fc", status: "running", cpu: 8, mem: 280,
    desc: "Deep-Research + persistenter Chrome (CDP), täglicher KI-News-Digest (HackerNews). Reflexe: deep-research, browser-research, reddit-digest.",
    axone: ["U1", "GEM", "MEM"],
    reflexe: ["Reddit-Digest", "Daily-Research", "Browser-Research"],
  },
  {
    id: "cst", name: "Cost-Guard", code: "CST", role: "Kosten-Wächter", tier: "deep",
    color: "#2dd4bf", status: "running", cpu: 2, mem: 110,
    desc: "Kosten-Tracking je Provider/Modell (cost-tracker.py im subunit-core). Reflex: cost-update.sh (alle 4 h + 5 Uhr Full-Rebuild).",
    axone: ["U1", "MON"],
    reflexe: ["Cost-Update"],
  },
  {
    id: "mon", name: "Monitor", code: "MON", role: "Self-Healing & Watchdogs", tier: "deep",
    color: "#fb923c", status: "running", cpu: 4, mem: 150,
    desc: "Infra-Monitoring, Self-Healing, RAM/Provider/GPU-Watchdogs. Reflexe: monitor-check (10 Min), self-healing (4 h), ram-watchdog, provider-health.",
    axone: ["U1", "CST"],
    reflexe: ["Monitor-Check", "Self-Healing", "RAM-Watchdog", "Provider-Health"],
  },
  {
    id: "vox", name: "Voice", code: "VOX", role: "Sprache rein/raus", tier: "surface",
    color: "#f472b6", status: "idle", cpu: 0, mem: 95,
    desc: "Sprachnachrichten transkribieren + als Voice antworten (alle Channels). Reflexe: transcribe-voice.sh, voice-reply.sh.",
    axone: ["U1", "MEE", "BRG"],
    reflexe: ["Voice-Transcribe", "Voice-Reply"],
  },
  {
    id: "dsg", name: "Compliance", code: "DSG", role: "DSGVO-Wächter", tier: "deep",
    color: "#94a3b8", status: "idle", cpu: 0, mem: 70,
    desc: "DSGVO/Compliance-Reflex — reiner 0-Token-Bash-Sensor, KEIN LLM. Reflex: dsgvo-scan.sh.",
    axone: ["U1"],
    reflexe: ["DSGVO-Scan"],
  },
  {
    id: "pls", name: "Pulse", code: "PLS", role: "Proaktive Kognition", tier: "surface",
    color: "#a78bfa", status: "running", cpu: 3, mem: 130,
    desc: "Puls mit Urteilsvermögen — JETZT-Snapshot zur proaktiven Bewertung (11/15/19 Uhr) + nächtliche Reflexion/\"Dream\". Reflexe: pulse.sh, reflect.sh.",
    axone: ["U1", "RES"],
    reflexe: ["Pulse", "Reflect"],
  },
  {
    id: "brg", name: "Bridge", code: "BRG", role: "Channels & Telegram", tier: "surface",
    color: "#36d399", status: "running", cpu: 5, mem: 160,
    desc: "Telegram/Channel-Bridge — eigener Inbound-Poller (getUpdates → tmux) + Outbound je Bot. Reflexe: tg-bridge, notify-*.",
    axone: ["U1", "VOX"],
    reflexe: ["Bridge-Poll", "Notify-Channel"],
  },
];

export interface LogTemplate {
  agent: string; // code
  msg: string;
  type: "info" | "success" | "warn";
}

/** Event-log templates streamed into the Cortex live feed. */
export const LOG_TEMPLATES: LogTemplate[] = [
  { agent: "U1", msg: "Routing-Advisor: Task → Gemini (1M-Kontext-Analyse)", type: "info" },
  { agent: "U1", msg: "Self-Healing-Reflex: alle Services nominal", type: "success" },
  { agent: "U1", msg: "Pulse 15:00 — proaktive Bewertung: ruhig", type: "info" },
  { agent: "GEM", msg: "Web-Grounding: 3 Quellen, Root-Cause isoliert", type: "success" },
  { agent: "GEM", msg: "Brainstorm-Pass: 5 Optionen an U1 zurück", type: "info" },
  { agent: "CDX", msg: "Adversarial-Review: 2 Befunde, 0 kritisch", type: "success" },
  { agent: "CDX", msg: "Security-Scan: Arg-Injection-Guard ok", type: "info" },
  { agent: "JUL", msg: "Async-Refactor gepusht — 4 Dateien (GitHub)", type: "success" },
  { agent: "MEM", msg: "Vector-Ingest: 23 Einträge → synapse-knowledge", type: "success" },
  { agent: "MEM", msg: "Index-Guard: MEMORY.md unter dem Lade-Limit", type: "info" },
  { agent: "MEE", msg: "Meeting-Intelligenz: Diarization fertig (4 Sprecher)", type: "success" },
  { agent: "RES", msg: "Reddit-Digest generiert (HackerNews → TJ)", type: "info" },
  { agent: "RES", msg: "Browser-Research: 6 Seiten via persistenten Chrome", type: "info" },
  { agent: "CST", msg: "Kosten-Update: heute 0,70 € · Monat 26,18 €", type: "info" },
  { agent: "MON", msg: "Monitor-Check: CPU 34% · RAM 62% · GPU nominal", type: "info" },
  { agent: "MON", msg: "RAM-Watchdog: Auto-Cleanup ausgelöst", type: "warn" },
  { agent: "VOX", msg: "Sprachnachricht transkribiert → Channel", type: "success" },
  { agent: "DSG", msg: "DSGVO-Scan: 0 Befunde", type: "success" },
  { agent: "PLS", msg: "Reflect: Material für den Nacht-Job gesammelt", type: "info" },
  { agent: "BRG", msg: "Bridge: 3 Inbound → tmux, 1 Voice-Reply raus", type: "info" },
];

export const TIER_LABEL: Record<Tier, string> = {
  surface: "Surface",
  core: "Core",
  deep: "Deep",
};
