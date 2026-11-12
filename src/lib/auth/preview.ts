/**
 * Live-preview hosts (server-only).
 *
 * The sandbox serves each live preview on a dynamic `https://*.grok-sandbox.com`
 * URL. Better Auth derives the preview's real origin from the request host and
 * validates it against this list (wildcard-matched), so the OAuth `redirect_uri`
 * becomes the concrete `https://<preview-host>/api/auth/callback/<providerId>`.
 * Google returns a code only to redirect URIs registered on the OAuth client,
 * so sign-in from a preview host needs that exact callback URL added there.
 */
export const PREVIEW_ALLOWED_HOSTS = ["*.grok-sandbox.com"] as const;
