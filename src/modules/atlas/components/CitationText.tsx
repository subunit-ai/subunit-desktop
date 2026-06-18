/**
 * CitationText — renders answer text with inline [n] / [n, m] markers turned
 * into clickable citation CHIPS. Clicking a chip calls onCite(n) so the parent
 * can highlight the matching source card + scroll it into view.
 *
 * The model is prompted to cite as bracketed numbers ("…revenue grew 12% [2]").
 * We match [1], [2,3], [1-3] forms; bare brackets that aren't citations (e.g.
 * "[note]") are left as plain text. `validNumbers` (when provided) restricts
 * which indices become chips, so stray brackets never become dead links.
 *
 * Ported from atlas-web/src/components/CitationText.jsx.
 */
import { Fragment, type CSSProperties, type JSX, type ReactNode } from "react";

const CITE_RE = /\[(\d+(?:\s*[,–-]\s*\d+)*)\]/g;

function expandRange(spec: string): number[] {
  const out: number[] = [];
  for (const part of spec.split(",")) {
    const range = part.split(/[–-]/).map((s) => parseInt(s.trim(), 10));
    if (range.length === 2 && Number.isFinite(range[0]) && Number.isFinite(range[1])) {
      const [a, b] = range[0] <= range[1] ? range : [range[1], range[0]];
      for (let i = a; i <= b; i++) out.push(i);
    } else if (Number.isFinite(range[0])) {
      out.push(range[0]);
    }
  }
  return out;
}

interface CitationTextProps {
  text?: string;
  validNumbers?: number[];
  onCite?: (n: number) => void;
  activeN?: number | null;
}

export default function CitationText({
  text = "",
  validNumbers,
  onCite,
  activeN,
}: CitationTextProps): JSX.Element {
  const valid = validNumbers ? new Set(validNumbers) : null;
  const nodes: ReactNode[] = [];
  let last = 0;
  let key = 0;
  let m: RegExpExecArray | null;

  CITE_RE.lastIndex = 0;
  while ((m = CITE_RE.exec(text)) !== null) {
    const nums = expandRange(m[1]);
    const usable = valid ? nums.filter((n) => valid.has(n)) : nums;
    if (usable.length === 0) continue;

    if (m.index > last) nodes.push(<Fragment key={key++}>{text.slice(last, m.index)}</Fragment>);

    nodes.push(
      <span key={key++} className="whitespace-nowrap">
        {usable.map((n) => {
          const activeStyle: CSSProperties | undefined =
            activeN === n
              ? { background: "rgba(0,242,255,0.22)", transform: "translateY(-1px)" }
              : undefined;
          return (
            <button
              key={n}
              type="button"
              className="cite-chip"
              data-cite={n}
              aria-label={`Source ${n}`}
              aria-pressed={activeN === n ? "true" : undefined}
              onClick={(e) => {
                e.stopPropagation();
                onCite?.(n);
              }}
              style={activeStyle}
            >
              {n}
            </button>
          );
        })}
      </span>,
    );
    last = m.index + m[0].length;
  }

  if (last < text.length) nodes.push(<Fragment key={key++}>{text.slice(last)}</Fragment>);

  return <>{nodes}</>;
}
