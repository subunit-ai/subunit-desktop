/**
 * WorkspaceSwitcher — the KnowledgeCompass as a domain switcher, plus a compact
 * list of the workspaces the JWT authorizes. The compass needle points at the
 * active workspace; clicking a rim waypoint OR a list row switches.
 *
 * atlas-api derives the per-workspace collection + HMAC signature server-side
 * from the JWT — the client only names WHICH workspace is active, never a
 * collection. The `wss` claim bounds what can appear here.
 *
 * Ported from atlas-web/src/components/WorkspaceSwitcher.jsx.
 */
import { type JSX } from "react";
import KnowledgeCompass, { type CompassWorkspace } from "./KnowledgeCompass";
import { workspaceLabel } from "../lib/format";

interface WorkspaceSwitcherProps {
  workspaces?: string[];
  activeId?: string | null;
  onSelect?: (id: string) => void;
}

export default function WorkspaceSwitcher({
  workspaces = [],
  activeId,
  onSelect,
}: WorkspaceSwitcherProps): JSX.Element {
  const items: CompassWorkspace[] = workspaces.map((w) => ({
    id: w,
    name: workspaceLabel(w),
  }));
  const active = items.find((w) => w.id === activeId);

  return (
    <div className="shrink-0">
      <div className="mb-3 px-1">
        <span className="kicker" style={{ fontSize: "0.62rem", letterSpacing: "0.28em" }}>
          Workspace
        </span>
      </div>

      <div className="glass p-4">
        <div className="mx-auto mb-3 aspect-square w-full max-w-[180px]">
          <KnowledgeCompass
            workspaces={items}
            activeId={activeId}
            onSelect={onSelect}
            className="h-full w-full"
          />
        </div>

        <p className="mb-3 text-center text-[0.95rem] font-semibold text-ink">
          {active ? active.name : "No workspace"}
        </p>

        {items.length > 1 && (
          <div className="space-y-1">
            {items.map((ws) => {
              const isActive = ws.id === activeId;
              return (
                <button
                  key={ws.id}
                  type="button"
                  onClick={() => onSelect?.(ws.id)}
                  className={`rail-item ${isActive ? "is-active" : ""}`}
                  aria-current={isActive ? "true" : undefined}
                >
                  <span
                    className="inline-block h-2 w-2 shrink-0 rounded-full"
                    style={{
                      background: isActive ? "#7df6ff" : "rgba(95,103,145,0.6)",
                      boxShadow: isActive ? "0 0 8px 1px rgba(0,242,255,0.8)" : "none",
                    }}
                    aria-hidden="true"
                  />
                  <span className="truncate">{ws.name}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
