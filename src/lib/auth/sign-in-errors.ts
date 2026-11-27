/**
 * What went wrong with a sign-in, in words a person can act on. The raw error text (from Better Auth
 * or the network) is English and technical, so the screen shows one of these kinds instead, each with
 * its own translated sentence (gates.tsx).
 */
export type SignInErrorKind = "rate_limited" | "popup_blocked" | "cancelled" | "offline" | "provider" | "failed";

export function signInErrorKind(error: unknown): SignInErrorKind {
  const status = typeof error === "object" && error !== null ? Number((error as { status?: unknown }).status) : NaN;
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (status === 429 || /too many/i.test(message)) return "rate_limited";
  if (/pop-?up blocked/i.test(message)) return "popup_blocked";
  if (/cancel/i.test(message)) return "cancelled";
  if (error instanceof TypeError || /failed to fetch|network|load failed/i.test(message)) return "offline";
  return "failed";
}

/**
 * Better Auth sends a failed sign-in back to the app with `?error=<code>` (the user said no at Cumulus
 * ID, the ID service was down, the state expired). Null when the URL carries no such error.
 */
export function signInErrorFromUrl(search: string): SignInErrorKind | null {
  const code = new URLSearchParams(search).get("error");
  if (!code) return null;
  if (/access_denied|cancel/i.test(code)) return "cancelled";
  if (/rate|too_many/i.test(code)) return "rate_limited";
  return "provider";
}
