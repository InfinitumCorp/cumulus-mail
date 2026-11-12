import { useEffect } from "react";
import { useCurrentUserState } from "@/lib/auth/use-current-user";

/**
 * The Cumulus://ID account bar: the same sign-in, account menu and product launcher in every
 * Infinitum product (https://id.cumuluscloud.app/id/bar.js, cumulus-id docs/integration.md).
 *
 * This app keeps its own Better Auth session, so the bar only shows who is signed in
 * (`setProfile`) and sends "Sign in" / "Sign out" to this app's /login and /logout routes.
 * The script is loaded once, the first time a bar mounts.
 */
const BAR_SRC = "https://id.cumuluscloud.app/id/bar.js";

type BarProfile = { name?: string | null; email?: string | null; username?: string | null; org_name?: string | null };
type BarApi = { setProfile(profile: BarProfile | null): void };

declare global {
  interface Window {
    CumulusBar?: BarApi;
  }
}

function loadBar(client: string): Promise<BarApi> {
  if (window.CumulusBar) return Promise.resolve(window.CumulusBar);
  let script = document.querySelector<HTMLScriptElement>("script[data-cumulus-bar-loader]");
  if (!script) {
    script = document.createElement("script");
    script.src = BAR_SRC;
    script.dataset.client = client;
    script.dataset.signin = "/login";
    script.dataset.signout = "/logout";
    script.dataset.cumulusBarLoader = "";
    document.head.append(script);
  }
  const loading = script;
  return new Promise((resolve, reject) => {
    loading.addEventListener("load", () => (window.CumulusBar ? resolve(window.CumulusBar) : reject(new Error("bar.js did not start"))), { once: true });
    loading.addEventListener("error", () => reject(new Error("bar.js did not load")), { once: true });
  });
}

/** The host element; place it at the right end of the header. `client` is the Cumulus://ID client id. */
export function CumulusBar({ client, className }: { client: string; className?: string }) {
  const { user, isPending } = useCurrentUserState();
  const name = user?.displayName ?? null;
  const email = user?.primaryEmail ?? null;
  const signedIn = Boolean(user);

  useEffect(() => {
    if (isPending) return;
    let live = true;
    loadBar(client)
      .then((bar) => {
        if (!live) return;
        bar.setProfile(signedIn ? { name, email, username: email ? email.split("@")[0] : null } : null);
      })
      .catch(() => {
        /* the bar is optional chrome: the app works without it */
      });
    return () => {
      live = false;
    };
  }, [client, isPending, signedIn, name, email]);

  return <div className={className} data-cumulus-bar />;
}
