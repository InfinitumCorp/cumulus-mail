import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { authClient, signOut } from "@/lib/auth/client";

export const Route = createFileRoute("/logout")({ component: Logout });

/** Ends this app's session (the Cumulus://ID account bar's "Sign out" links here), then returns home. */
function Logout() {
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    void signOut("/").catch(async () => {
      // Nothing to sign out of: go home rather than report a failure.
      const session = await authClient.getSession().catch(() => null);
      if (session && !session.error && !session.data) window.location.replace("/");
      else setFailed(true);
    });
  }, []);
  return (
    <main className="grid min-h-dvh place-items-center px-4">
      {failed ? (
        <p role="alert">
          Sign-out didn't finish. <a href="/logout">Try again</a> or <a href="/">go back</a>.
        </p>
      ) : (
        <p role="status">Signing out…</p>
      )}
    </main>
  );
}
