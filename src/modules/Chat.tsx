/**
 * Chat module — hosts the live Telegram-alternative chat at chat.subunit.ai.
 *
 * For now this is a thin host around the existing web app (WebFrame/iframe).
 * The hosted app uses Subunit SSO; if the embedded session can't complete
 * sign-in, the "open in browser" button in the frame bar is the escape hatch.
 */

import { WebFrame } from "./WebFrame";

export default function ChatModule() {
  return (
    <WebFrame
      url="https://chat.subunit.ai"
      title="Subunit Chat"
      note="Requires Subunit SSO"
    />
  );
}
