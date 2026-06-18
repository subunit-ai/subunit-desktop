/**
 * EmptyState — the center pane before the first question. Starfield behind a
 * floating Atlas mark and the product slogan "Navigate your knowledge", with a
 * few example prompts the user can fire straight off.
 *
 * Ported from atlas-web/src/components/EmptyState.jsx.
 */
import { type JSX } from "react";
import Starfield from "./Starfield";
import { AtlasLogoMark } from "./AtlasLogo";

const SUGGESTIONS = [
  "Summarise what we know about pricing",
  "What did the last meeting decide?",
  "Find the contract renewal terms",
];

interface EmptyStateProps {
  onPick?: (suggestion: string) => void;
}

export default function EmptyState({ onPick }: EmptyStateProps): JSX.Element {
  return (
    <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden">
      <Starfield className="pointer-events-none absolute inset-0 h-full w-full" density={0.00014} />

      <div className="relative z-10 flex flex-col items-center px-6 text-center">
        <div className="animate-float mb-6">
          <AtlasLogoMark size={76} />
        </div>

        <h1 className="h-section mb-3 text-[clamp(1.8rem,4vw,2.8rem)]">
          <span className="text-gradient-vc">Navigate your knowledge</span>
        </h1>

        <p className="mb-8 max-w-md text-[0.95rem] leading-relaxed text-ink-muted">
          Ask anything across this workspace. Every answer is grounded in your own documents and
          cites its sources.
        </p>

        <div className="flex flex-wrap justify-center gap-2">
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => onPick?.(s)}
              className="pill transition-colors hover:border-[rgba(167,139,255,0.55)] hover:text-ink"
              style={{ cursor: "pointer", textTransform: "none", letterSpacing: "0.02em" }}
            >
              {s}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
