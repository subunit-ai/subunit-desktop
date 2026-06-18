/**
 * Call module — placeholder/launcher for call.subunit.ai.
 *
 * call.subunit.ai is a stub today, so this is a clean "coming soon" surface with
 * an escape hatch to open the web stub in a browser.
 */

import { ComingSoon } from "./ComingSoon";
import { CallIcon, ExternalIcon } from "../components/icons";
import { openExternal } from "../lib/ipc";

export default function CallModule() {
  return (
    <ComingSoon
      icon={CallIcon}
      title="Call"
      blurb="Real-time calls inside Subunit. The web surface is still a stub; the module will host it once call.subunit.ai goes live."
      action={
        <button
          type="button"
          className="cta-ghost"
          onClick={() => openExternal("https://call.subunit.ai")}
        >
          <ExternalIcon size={15} />
          Open call.subunit.ai
        </button>
      }
    />
  );
}
