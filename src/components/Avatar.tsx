/**
 * Avatar — a profile image inside any of the app's initials-avatar circles.
 *
 * Renders the SAME wrapper `<span class={className}>` every surface already
 * styles (titlebar `.ini`, settings `.set-avatar`, team `.tm-av`, chat
 * `.msn-av`, …) and swaps the content: when `url` is set and the image loads,
 * an `<img class="av-img">` fills the circle; otherwise (no avatar, or the
 * image failed to load) EXACTLY today's initials/icon markup renders via
 * `fallback`. Overlays that must survive either way (presence dot) go in
 * `children`.
 *
 * The URL comes versioned from auth.subunit.ai (`…/avatar/<id>?v=<hex>`) —
 * use it raw, never cache-bust it yourself. `.av-img` lives in index.css.
 */

import { useEffect, useState, type ReactNode } from "react";

export function Avatar(p: {
  /** Versioned public avatar URL; ""/undefined/null → fallback. */
  url?: string | null;
  /** The surface's existing avatar class (e.g. "msn-av sm", "tm-av", "ini"). */
  className: string;
  /** Today's initials/icon content — shown when there is no (loadable) image. */
  fallback: ReactNode;
  /** Overlays rendered in BOTH states (e.g. the presence dot). */
  children?: ReactNode;
  /** Mirrors the aria-hidden of the markup being replaced (decorative avatars). */
  ariaHidden?: boolean;
  title?: string;
}) {
  const [failed, setFailed] = useState(false);
  // A NEW url (e.g. after re-upload) gets a fresh load attempt.
  useEffect(() => setFailed(false), [p.url]);

  const showImg = !!p.url && !failed;
  return (
    <span
      className={p.className}
      aria-hidden={p.ariaHidden || undefined}
      title={p.title}
    >
      {showImg ? (
        <img
          className="av-img"
          src={p.url!}
          alt=""
          draggable={false}
          onError={() => setFailed(true)}
        />
      ) : (
        p.fallback
      )}
      {p.children}
    </span>
  );
}
