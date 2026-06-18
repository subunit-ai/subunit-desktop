/**
 * Sidebar — the left module rail.
 *
 * Brand lockup on top, the 5 module nav items in the middle (icon + label +
 * active state, "Soon" badge for placeholders), and an account chip + version
 * pinned to the bottom. Reads the module list from lib/modules so the nav and
 * the command palette never drift apart.
 */

import { NavLink } from "react-router-dom";
import { MODULES } from "../lib/modules";
import { SubunitMark } from "./SubunitMark";
import { AccountChip } from "./AccountChip";

export function Sidebar({ version }: { version: string }) {
  return (
    <nav className="rail" aria-label="Modules">
      <div className="rail-brand">
        <SubunitMark size={24} />
        <span className="rail-brand-name">Subunit</span>
      </div>

      <div className="rail-items">
        {MODULES.map((m) => {
          const Icon = m.icon;
          return (
            <NavLink
              key={m.path}
              to={m.path}
              className={({ isActive }) =>
                `rail-item${isActive ? " is-active" : ""}`
              }
            >
              <span className="rail-glyph" aria-hidden>
                <Icon size={18} />
              </span>
              <span className="rail-label">{m.label}</span>
              {m.status === "soon" && <span className="rail-soon">Soon</span>}
            </NavLink>
          );
        })}
      </div>

      <div className="rail-foot">
        <AccountChip />
        <div className="rail-version">v{version}</div>
      </div>
    </nav>
  );
}
