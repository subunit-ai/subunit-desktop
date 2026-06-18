/**
 * modules.tsx — the single source of truth for the shell's module registry.
 *
 * The sidebar nav, the command palette, the router and the top-bar title all
 * read from this one list so a module is described exactly once. Each entry
 * carries its route, label, a one-line hint, and the stroke icon shown in nav.
 */

import type { ComponentType } from "react";
import {
  AtlasIcon,
  CallIcon,
  ChatIcon,
  EchoIcon,
  SynapseIcon,
} from "../components/icons";

export interface ModuleDef {
  path: string;
  label: string;
  hint: string;
  icon: ComponentType<{ size?: number }>;
  /** Live = wired to a real backend; Soon = placeholder/launcher. */
  status: "live" | "soon";
}

export const MODULES: ModuleDef[] = [
  {
    path: "/atlas",
    label: "Atlas",
    hint: "Cited-RAG knowledge console",
    icon: AtlasIcon,
    status: "live",
  },
  {
    path: "/synapse",
    label: "Synapse",
    hint: "Ingest funnel + Axon review",
    icon: SynapseIcon,
    status: "live",
  },
  {
    path: "/chat",
    label: "Chat",
    hint: "chat.subunit.ai",
    icon: ChatIcon,
    status: "live",
  },
  {
    path: "/call",
    label: "Call",
    hint: "call.subunit.ai — coming soon",
    icon: CallIcon,
    status: "soon",
  },
  {
    path: "/echo",
    label: "Echo",
    hint: "Transcription app",
    icon: EchoIcon,
    status: "soon",
  },
];

export const DEFAULT_ROUTE = "/atlas";

/** Look up the module whose route matches the current location pathname. */
export function moduleForPath(pathname: string): ModuleDef | undefined {
  return MODULES.find((m) => pathname.startsWith(m.path));
}
