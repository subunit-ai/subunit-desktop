/**
 * agents.ts — the SNI agent registry (the "nervous system").
 *
 * Ported verbatim from the SNI source (subunit-ai/sni, src/data/agents.js):
 * U1 the orchestrator plus 11 specialist agents (S-01…S-11) across three tiers.
 * Each agent carries its live-ish status/cpu/mem, its AXONE (connections to
 * other agents) and its REFLEXE (automatic triggers). The Cortex view renders
 * this as a neural map; the agent codes in `axone` reference other agents' `code`.
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
}

export const AGENTS: Agent[] = [
  {
    id: "u1", name: "Unit One", code: "U1", role: "Orchestrator", tier: "core",
    color: "#00f0ff", status: "running", cpu: 12, mem: 340,
    desc: "Zentraler Orchestrator — koordiniert alle Agenten, routet Aufgaben, überwacht Systemzustand.",
    axone: ["S-01", "S-02", "S-03", "S-04", "S-05", "S-06", "S-07", "S-08", "S-09", "S-10", "S-11"],
    reflexe: ["Workflow-Routing", "Fehler-Eskalation", "Last-Balancing", "Health-Check", "Auto-Recovery"],
  },
  {
    id: "s01", name: "Radar", code: "S-01", role: "Lead Intelligence", tier: "surface",
    color: "#ff6b35", status: "running", cpu: 8, mem: 220,
    desc: "Lead-Scoring, Quellenanalyse, automatische Bewertung eingehender Kontakte.",
    axone: ["U1", "S-02", "S-08"],
    reflexe: ["Neuer-Lead-Trigger", "Score-Threshold", "Duplikat-Check"],
  },
  {
    id: "s02", name: "Kontakt", code: "S-02", role: "Customer Relations", tier: "surface",
    color: "#36d399", status: "running", cpu: 5, mem: 180,
    desc: "Kundenprofilverwaltung, Kommunikationshistorie, Segmentierung.",
    axone: ["U1", "S-01", "S-03", "S-05"],
    reflexe: ["Profil-Update", "Follow-Up-Timer", "Churn-Alert"],
  },
  {
    id: "s03", name: "Kalender", code: "S-03", role: "Scheduling", tier: "surface",
    color: "#a78bfa", status: "running", cpu: 3, mem: 120,
    desc: "Terminbuchung, Verfügbarkeitsmanagement, automatische Erinnerungen.",
    axone: ["U1", "S-02"],
    reflexe: ["Buchungs-Trigger", "Reminder-24h", "Konflikt-Check"],
  },
  {
    id: "s04", name: "Wissen", code: "S-04", role: "Knowledge Base", tier: "core",
    color: "#fbbf24", status: "running", cpu: 15, mem: 480,
    desc: "RAG-basierte Wissensdatenbank, Dokumentenverarbeitung, semantische Suche.",
    axone: ["U1", "S-01", "S-02", "S-05", "S-07", "S-09"],
    reflexe: ["Dokument-Ingest", "Embedding-Update", "Query-Cache"],
  },
  {
    id: "s05", name: "Inbox", code: "S-05", role: "Email Processing", tier: "surface",
    color: "#38bdf8", status: "running", cpu: 6, mem: 200,
    desc: "E-Mail-Klassifikation, automatische Antworten, Eskalationslogik.",
    axone: ["U1", "S-02", "S-04"],
    reflexe: ["Email-Eingang", "Auto-Reply", "Spam-Filter", "Eskalation"],
  },
  {
    id: "s06", name: "Social", code: "S-06", role: "Social Media", tier: "core",
    color: "#f472b6", status: "idle", cpu: 0, mem: 90,
    desc: "Social-Media-Monitoring, automatisches Posting, Engagement-Tracking.",
    axone: ["U1", "S-07", "S-08"],
    reflexe: ["Post-Schedule", "Mention-Alert", "Engagement-Spike"],
  },
  {
    id: "s07", name: "Content", code: "S-07", role: "Content Engine", tier: "core",
    color: "#c084fc", status: "running", cpu: 18, mem: 520,
    desc: "Content-Generierung, SEO-Optimierung, Multi-Format-Output.",
    axone: ["U1", "S-04", "S-06"],
    reflexe: ["Content-Request", "SEO-Audit", "Format-Convert"],
  },
  {
    id: "s08", name: "Analyse", code: "S-08", role: "Analytics", tier: "deep",
    color: "#2dd4bf", status: "running", cpu: 22, mem: 610,
    desc: "Datenanalyse, KPI-Tracking, automatisierte Berichterstattung.",
    axone: ["U1", "S-01", "S-06", "S-10"],
    reflexe: ["Report-Schedule", "Anomalie-Detect", "KPI-Threshold"],
  },
  {
    id: "s09", name: "Onboard", code: "S-09", role: "Client Onboarding", tier: "deep",
    color: "#4ade80", status: "idle", cpu: 0, mem: 85,
    desc: "Automatisiertes Kunden-Onboarding, Checklisten, Dokumentensammlung.",
    axone: ["U1", "S-02", "S-04"],
    reflexe: ["Neukunde-Trigger", "Schritt-Validierung", "Onboard-Complete"],
  },
  {
    id: "s10", name: "Monitor", code: "S-10", role: "System Monitor", tier: "deep",
    color: "#fb923c", status: "running", cpu: 4, mem: 150,
    desc: "Infrastruktur-Monitoring, Uptime-Tracking, Performance-Alerts.",
    axone: ["U1", "S-08"],
    reflexe: ["Health-Ping", "CPU-Alert", "Memory-Alert", "Downtime-Alert"],
  },
  {
    id: "s11", name: "Legal", code: "S-11", role: "Compliance", tier: "deep",
    color: "#94a3b8", status: "idle", cpu: 0, mem: 75,
    desc: "DSGVO-Compliance, Vertragsprüfung, Audit-Logging.",
    axone: ["U1", "S-04"],
    reflexe: ["Compliance-Scan", "DSGVO-Check", "Audit-Log", "Vertragsfrist"],
  },
];

export interface LogTemplate {
  agent: string; // code
  msg: string;
  type: "info" | "success" | "warn";
}

/** Event-log templates streamed into the Cortex live feed. */
export const LOG_TEMPLATES: LogTemplate[] = [
  { agent: "U1", msg: "Orchestrating workflow: lead-qualification-pipeline", type: "info" },
  { agent: "U1", msg: "Health check complete — all nodes nominal", type: "success" },
  { agent: "U1", msg: "Routing inbound request → S-01 Radar", type: "info" },
  { agent: "U1", msg: "Load balancing: shifting S-07 tasks to queue", type: "warn" },
  { agent: "S-01", msg: "Lead scored: MüllerTech GmbH → 87/100 (qualified)", type: "success" },
  { agent: "S-01", msg: "Scanning 4 new inbound leads from web form", type: "info" },
  { agent: "S-01", msg: "Duplicate detected — merging with existing record", type: "warn" },
  { agent: "S-02", msg: "Customer profile updated: MüllerTech GmbH", type: "success" },
  { agent: "S-02", msg: "Churn risk alert: KundeXY — 14 Tage inaktiv", type: "warn" },
  { agent: "S-03", msg: "Discovery Call gebucht: 2026-03-18 14:00 CET", type: "success" },
  { agent: "S-04", msg: "RAG query processed in 340ms — 3 chunks retrieved", type: "success" },
  { agent: "S-04", msg: "Embedding-Update: 23 neue Dokumente verarbeitet", type: "info" },
  { agent: "S-04", msg: "Knowledge base sync complete: 1.247 Einträge", type: "success" },
  { agent: "S-05", msg: "Auto-Reply gesendet: Bestätigung #4821", type: "success" },
  { agent: "S-05", msg: "Eskalation: Dringende Anfrage → U1", type: "warn" },
  { agent: "S-07", msg: "Blog-Post generiert: 'KI im Mittelstand' (1.840 Wörter)", type: "success" },
  { agent: "S-08", msg: "Anomalie: Conversion-Rate -15% vs. Vorwoche", type: "warn" },
  { agent: "S-08", msg: "Weekly Report generiert: KW12 Performance", type: "info" },
  { agent: "S-10", msg: "System health: CPU 34% | RAM 62% | Disk 41%", type: "info" },
  { agent: "S-10", msg: "Docker container s07-content restarted (OOM)", type: "warn" },
];

export const TIER_LABEL: Record<Tier, string> = {
  surface: "Surface",
  core: "Core",
  deep: "Deep",
};
