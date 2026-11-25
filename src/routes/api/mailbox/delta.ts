import { createFileRoute } from "@tanstack/react-router";

/**
 * `POST /api/mailbox/delta`: the change a closing tab had not finished saving (src/lib/mail/delta.ts),
 * sent with `keepalive` from `pagehide` (src/lib/mail/store.ts). A plain route, not a server function,
 * because the request has to start synchronously while the page unloads.
 *
 * The same checks as a full save: same-site only, the session (cookie, or the preview's bearer token),
 * the mailbox second factor (sessionMailbox), a per-mailbox rate limit, then writeSnapshot's own checks.
 * The body is capped at 64 KiB, the most a keepalive request can carry.
 */
const MAX_BODY = 64 * 1024;

export const Route = createFileRoute("/api/mailbox/delta")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { assertSameSiteRequest } = await import("@/lib/auth/isolation.server");
        try {
          assertSameSiteRequest();
        } catch {
          return new Response("Forbidden", { status: 403 });
        }
        const auth = request.headers.get("authorization") ?? "";
        const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() || undefined : undefined;
        const { requireUserId } = await import("@/lib/auth/verify.server");
        let userId: string;
        try {
          userId = await requireUserId(bearer);
        } catch {
          return new Response("Unauthorized", { status: 401 });
        }
        const declared = Number(request.headers.get("content-length") ?? "0");
        if (declared > MAX_BODY) return new Response("Too large", { status: 413 });
        const text = await request.text();
        if (text.length > MAX_BODY) return new Response("Too large", { status: 413 });
        const { asDelta } = await import("@/lib/mail/delta-check");
        let delta;
        try {
          delta = asDelta(JSON.parse(text));
        } catch {
          return new Response("Bad request", { status: 400 });
        }
        const { writeMailboxDeltaForSession } = await import("@/lib/mail/mailbox.server");
        try {
          await writeMailboxDeltaForSession(userId, delta, bearer);
        } catch (error) {
          const { FACTOR_REQUIRED } = await import("@/lib/auth/factor-gate");
          const message = error instanceof Error ? error.message : "";
          const status = message === FACTOR_REQUIRED ? 403 : error instanceof Error && error.name === "RateLimitedError" ? 429 : 400;
          return new Response(status === 400 ? "Not saved" : message, { status });
        }
        return new Response(null, { status: 204 });
      },
    },
  },
});
