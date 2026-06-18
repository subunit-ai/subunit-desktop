/**
 * ComingSoon — a polished launcher/placeholder surface for modules that aren't
 * wired yet (Call, Echo). Glass card on the starfield ground with the module's
 * own icon, a one-line description, and an optional action (open the web stub /
 * launch the standalone app).
 */

import type { ComponentType, ReactNode } from "react";

export function ComingSoon({
  icon: Icon,
  title,
  blurb,
  action,
}: {
  icon: ComponentType<{ size?: number }>;
  title: string;
  blurb: string;
  action?: ReactNode;
}) {
  return (
    <div className="soon-wrap">
      <div className="soon-card glass-card">
        <div className="soon-glyph" aria-hidden>
          <Icon size={34} />
        </div>
        <span className="soon-kicker">Coming soon</span>
        <h2 className="soon-title">{title}</h2>
        <p className="soon-blurb">{blurb}</p>
        {action && <div className="soon-action">{action}</div>}
      </div>
    </div>
  );
}
