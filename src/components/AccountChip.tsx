/**
 * AccountChip — the sidebar-foot identity control.
 *
 * Renders the signed-in account (email + plan) with a sign-out action, or a
 * "Sign in" button that kicks off the Tauri loopback-SSO flow. Login is async
 * and can take a while (the browser tab must complete OAuth), so we show a
 * "waiting for browser…" state and stay responsive throughout.
 *
 * In a plain browser tab (dev) there's no loopback host; the chip reflects the
 * dev token if present and otherwise shows the local-dev hint.
 */

import { useEffect, useState } from "react";
import {
  type Account,
  fetchAccount,
  login,
  logout,
  onAccountChange,
  primeAtlasToken,
} from "../lib/auth";
import { isTauri } from "../lib/ipc";
import { IS_LOCAL_DEV } from "../lib/config";
import { SignInIcon, SignOutIcon, UserIcon } from "./icons";

export function AccountChip() {
  const [account, setAccount] = useState<Account | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    primeAtlasToken().then(() => fetchAccount()).then((a) => {
      if (alive) setAccount(a);
    });
    const off = onAccountChange((a) => alive && setAccount(a));
    return () => {
      alive = false;
      off();
    };
  }, []);

  async function handleLogin() {
    setBusy(true);
    setError("");
    try {
      await login();
      setAccount(await fetchAccount());
    } catch (e) {
      setError(e instanceof Error ? e.message : "sign-in failed");
    } finally {
      setBusy(false);
    }
  }

  async function handleLogout() {
    setBusy(true);
    try {
      await logout();
      setAccount(await fetchAccount());
    } finally {
      setBusy(false);
    }
  }

  if (busy && !account?.logged_in) {
    return (
      <div className="acct-chip is-waiting" aria-live="polite">
        <span className="acct-spinner" aria-hidden />
        <span className="acct-meta">
          <span className="acct-name">Waiting for browser…</span>
          <span className="acct-sub">Complete sign-in in your browser</span>
        </span>
      </div>
    );
  }

  if (account?.logged_in) {
    return (
      <button
        type="button"
        className="acct-chip"
        onClick={handleLogout}
        disabled={busy}
        title="Sign out"
      >
        <span className="acct-avatar" aria-hidden>
          <UserIcon size={16} />
        </span>
        <span className="acct-meta">
          <span className="acct-name">{account.email || "Signed in"}</span>
          <span className="acct-sub">{account.plan}</span>
        </span>
        <span className="acct-action" aria-hidden>
          <SignOutIcon size={15} />
        </span>
      </button>
    );
  }

  return (
    <button
      type="button"
      className="acct-chip acct-signin"
      onClick={handleLogin}
      disabled={busy}
      title={isTauri() ? "Sign in via browser" : "Local dev"}
    >
      <span className="acct-avatar" aria-hidden>
        <SignInIcon size={16} />
      </span>
      <span className="acct-meta">
        <span className="acct-name">{isTauri() ? "Sign in" : "Local dev"}</span>
        <span className="acct-sub">
          {error || (IS_LOCAL_DEV ? "auth bypass" : "auth.subunit.ai")}
        </span>
      </span>
    </button>
  );
}
