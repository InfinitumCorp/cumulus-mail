import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { signIn } from "@/lib/auth/client";
import { CUMULUS_ID_CREATE_PROVIDER_ID, CUMULUS_ID_PROVIDER_ID } from "@/lib/auth/providers";
import { SignInScreen } from "@/lib/auth/gates";

export const Route = createFileRoute("/login")({ component: Login });

/**
 * Starts this app's Cumulus://ID sign-in (the Cumulus://ID account bar's "Sign in" links here;
 * `?prompt=create` opens on "Create a Cumulus://ID"). If it can't start on its own (the live
 * preview needs a click for its popup), the usual sign-in buttons are shown instead.
 */
function Login() {
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const create = new URLSearchParams(window.location.search).get("prompt") === "create";
    void signIn(create ? CUMULUS_ID_CREATE_PROVIDER_ID : CUMULUS_ID_PROVIDER_ID, { callbackURL: "/" }).catch(() => setFailed(true));
  }, []);
  if (failed) return <SignInScreen title="Cumulus://Mail" />;
  return (
    <main className="grid min-h-dvh place-items-center px-4">
      <p role="status">Signing in with Cumulus://ID…</p>
    </main>
  );
}
