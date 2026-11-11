/**
 * The sign-in choices this app offers: Cumulus ID only.
 *
 * Source of truth for BOTH the server (`server.ts`, one `genericOAuth` provider
 * per entry) and the client (`client.ts` / sign-in buttons). Kept dependency-free
 * so the client can import it without pulling in the server-only Better Auth
 * instance. Both entries use the same Cumulus ID client; the second asks the
 * issuer to open on "Create a Cumulus ID" and returns here signed in.
 */
export {
  CUMULUS_ID_CREATE_PROVIDER_ID,
  CUMULUS_ID_PROVIDER_ID,
  SIGN_IN_PROVIDERS,
  type SignInProvider,
} from "./cumulus-id.ts";
