/**
 * Live-preview hosts (server-only).
 *
 * The sandbox serves each live preview on a dynamic `https://*.grok-sandbox.com`
 * URL. Better Auth derives the preview's real origin from the request host and
 * validates it against this list (wildcard-matched), so the OAuth `redirect_uri`
 * becomes the concrete `https://<preview-host>/api/auth/callback/<providerId>`.
 * Cumulus ID returns a code only to origins registered for the `cumulus-mail`
 * client, so sign-in from a preview host needs that origin added in nexus.
 */
export const PREVIEW_ALLOWED_HOSTS = ["*.grok-sandbox.com"] as const;
