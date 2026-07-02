/**
 * sni.ts — typed client for the Subunit Neural Interface (sni.subunit.ai).
 *
 * Every call goes through `host.backend.fetch("sni-api", …)`, which:
 *   · resolves the base to https://sni.subunit.ai (config.ts BACKENDS["sni-api"]),
 *   · attaches the short-lived first-party bearer (accepted by SNI after the
 *     sni-live server patch — see deploy/sni-live/),
 *   · is gated by the caller's `backend:sni-api` permission.
 *
 * Live/Demo contract: every fetcher throws on non-2xx or network error. Views use
 * `useSniResource` (or `withFallback`) to degrade to mock data and flag the source
 * as "demo" — the cockpit never crashes when SNI is unreachable (e.g. before the
 * server lever is pulled, or when the tunnel is down). It flips to "live" by itself
 * the moment the server answers.
 *
 * Shapes below are read 1:1 from the SNI server route handlers (server.js). Loose
 * where the server payload is rich/nested (agents, security) — adapted per view.
 */
import { useEffect, useState } from "react";
import type { HostApi } from "../plugin/types";

const B = "sni-api";

// ── contract shapes (from server.js handlers) ────────────────────────────────
export interface SniGpu {
  name: string;
  tempC: number;
  utilization: number;
  memUsedMB: number;
  memTotalMB: number;
  powerDraw?: number;
  powerLimit?: number;
  fanSpeed?: number;
  clockGr?: number;
  clockMem?: number;
  driverVersion?: string;
}

/** /api/axone → n8n workflows (502 {offline:true} when n8n is down). */
export interface SniAxon {
  id: string | number;
  name: string;
  active: boolean;
  updatedAt?: string;
  nodeCount: number;
}

/** /api/reflexe → tools.json entries + mtime. */
export interface SniReflex {
  name: string;
  script?: string;
  desc?: string;
  updatedAt?: string;
  [k: string]: unknown;
}

export interface SniUsageModel {
  model: string;
  tokens: number;
  cost?: number;
  [k: string]: unknown;
}
export interface SniUsageToday {
  totalCostUSD: number;
  byModel: SniUsageModel[];
  [k: string]: unknown;
}

export interface SniSecurityDashboard {
  realtime?: unknown;
  forecast?: unknown;
  alerts?: unknown;
  budgets?: unknown;
  billing?: unknown;
  [k: string]: unknown;
}

/** /api/agents → buildAgentData(); rich registry, kept loose + adapted per view. */
export interface SniAgentRaw {
  code?: string;
  name?: string;
  status?: string;
  cpu?: number;
  mem?: number;
  [k: string]: unknown;
}

// ── low-level ────────────────────────────────────────────────────────────────
async function get<T>(host: HostApi, path: string, signal?: AbortSignal): Promise<T> {
  const res = await host.backend.fetch(B, path, signal ? { signal } : undefined);
  if (!res.ok) throw new Error(`sni ${path} → HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** Typed fetchers — one per SNI route the cockpit consumes. */
export const sni = {
  health: (h: HostApi, s?: AbortSignal) => get<{ status: string }>(h, "/api/health", s),
  gpu: (h: HostApi, s?: AbortSignal) => get<SniGpu>(h, "/api/gpu", s),
  agents: (h: HostApi, s?: AbortSignal) =>
    get<SniAgentRaw[] | Record<string, unknown>>(h, "/api/agents", s),
  axone: (h: HostApi, s?: AbortSignal) => get<SniAxon[]>(h, "/api/axone", s),
  reflexe: (h: HostApi, s?: AbortSignal) => get<SniReflex[]>(h, "/api/reflexe", s),
  usageToday: (h: HostApi, s?: AbortSignal) => get<SniUsageToday>(h, "/api/usage/today", s),
  security: (h: HostApi, s?: AbortSignal) => get<SniSecurityDashboard>(h, "/api/security/dashboard", s),
};

// ── live/demo ────────────────────────────────────────────────────────────────
export type SniSource = "live" | "demo";
export interface SniResult<T> {
  data: T;
  source: SniSource;
  error?: string;
}

/** Try the live fetch; on any failure fall back to `mock` and flag "demo". */
export async function withFallback<T>(live: () => Promise<T>, mock: T): Promise<SniResult<T>> {
  try {
    return { data: await live(), source: "live" };
  } catch (e) {
    return { data: mock, source: "demo", error: e instanceof Error ? e.message : String(e) };
  }
}

export interface UseSniResource<T> {
  data: T;
  source: SniSource;
  loading: boolean;
  error?: string;
  reload: () => void;
}

/**
 * Fetch a live SNI resource with graceful demo fallback + optional refresh.
 * Renders `mock` immediately (source "demo") and swaps to live on success.
 * Pass a STABLE `mock` (module-const), not an inline literal.
 */
export function useSniResource<T>(
  host: HostApi,
  live: (h: HostApi, s?: AbortSignal) => Promise<T>,
  mock: T,
  opts?: { refreshMs?: number },
): UseSniResource<T> {
  const [data, setData] = useState<T>(mock);
  const [source, setSource] = useState<SniSource>("demo");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);
  const [tick, setTick] = useState(0);
  const reload = () => setTick((t) => t + 1);

  useEffect(() => {
    let on = true;
    const ac = new AbortController();
    setLoading(true);
    live(host, ac.signal)
      .then((d) => {
        if (!on) return;
        setData(d);
        setSource("live");
        setError(undefined);
      })
      .catch((e) => {
        if (!on || ac.signal.aborted) return;
        setData(mock);
        setSource("demo");
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (on) setLoading(false);
      });
    return () => {
      on = false;
      ac.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host, live, tick]);

  useEffect(() => {
    if (!opts?.refreshMs) return;
    const id = setInterval(reload, opts.refreshMs);
    return () => clearInterval(id);
  }, [opts?.refreshMs]);

  return { data, source, loading, error, reload };
}
