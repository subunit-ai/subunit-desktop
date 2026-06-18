/**
 * ModuleHost — resilient host for the Atlas + Synapse module surfaces.
 *
 * Those two surfaces are authored by a sibling agent under `src/modules/atlas`
 * and `src/modules/synapse` (default exports via each module's `index.ts`). Now
 * that both exist, we lazy-import them STATICALLY so Vite bundles + code-splits
 * them into real async chunks (and Tailwind scans their files for the Atlas
 * design utilities). A `@vite-ignore` computed specifier — the earlier
 * placeholder-tolerant approach — would be excluded from the production graph
 * and 404 at runtime in the bundled Tauri app, so it's intentionally gone now
 * that the modules are real. Each surface still mounts inside an error boundary
 * + suspense fallback, so a slow/failed module degrades gracefully rather than
 * blanking the window.
 *
 * Before the module mounts we `primeAtlasToken()` so the ported atlas-web code
 * (which reads `window.__ATLAS_TOKEN__`) is authenticated the instant it runs.
 */

import {
  Component,
  type ReactNode,
  lazy,
  Suspense,
  useEffect,
  useState,
} from "react";
import { primeAtlasToken } from "../lib/auth";

const AtlasSurface = lazy(() => import("../modules/atlas"));
const SynapseSurface = lazy(() => import("../modules/synapse"));

export function AtlasRoute() {
  return (
    <ModuleBoundary name="Atlas">
      <AtlasSurface />
    </ModuleBoundary>
  );
}

export function SynapseRoute() {
  return (
    <ModuleBoundary name="Synapse">
      <SynapseSurface />
    </ModuleBoundary>
  );
}

/** Primes the Atlas token, then renders the lazy module inside an error
 *  boundary + suspense fallback so a slow/absent module never blanks the app. */
function ModuleBoundary({ name, children }: { name: string; children: ReactNode }) {
  const [primed, setPrimed] = useState(false);
  useEffect(() => {
    primeAtlasToken().finally(() => setPrimed(true));
  }, []);
  if (!primed) return <ModuleSpinner name={name} />;
  return (
    <ModuleErrorBoundary name={name}>
      <Suspense fallback={<ModuleSpinner name={name} />}>{children}</Suspense>
    </ModuleErrorBoundary>
  );
}

function ModuleSpinner({ name }: { name: string }) {
  return (
    <div className="module-fallback" aria-live="polite">
      <span className="module-spinner" aria-hidden />
      <span>Loading {name}…</span>
    </div>
  );
}

class ModuleErrorBoundary extends Component<
  { name: string; children: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <div className="module-fallback">
          <span className="module-fallback-title">
            {this.props.name} couldn’t load
          </span>
          <span className="module-fallback-sub">
            {this.state.error.message}
          </span>
        </div>
      );
    }
    return this.props.children;
  }
}
