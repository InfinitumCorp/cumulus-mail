/**
 * The sign-in choices this app offers: Google only.
 *
 * Source of truth for BOTH the server (`server.ts`, Better Auth's built-in
 * Google provider) and the client (`client.ts` / sign-in buttons). Kept
 * dependency-free so the client can import it without pulling in the
 * server-only Better Auth instance.
 */
export const GOOGLE_PROVIDER_ID = "google";

export type SignInProvider = {
  /** Better Auth provider id; also the callback path segment. */
  providerId: string;
  /** Button text. */
  label: string;
};

export const SIGN_IN_PROVIDERS: readonly SignInProvider[] = [
  { providerId: GOOGLE_PROVIDER_ID, label: "Sign in with Google" },
];

type GoogleEnv = { GOOGLE_CLIENT_ID?: string; GOOGLE_CLIENT_SECRET?: string };

export type GoogleConfig = { clientId: string; clientSecret: string };

/**
 * Google OAuth client from the environment. The client id is public; the secret
 * is set by the owner in the platform's secret store and never committed.
 * Returns null unless both are present, so sign-in stays off rather than half-on.
 */
export function googleConfig(env: GoogleEnv = process.env): GoogleConfig | null {
  const clientId = env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_CLIENT_SECRET?.trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}
