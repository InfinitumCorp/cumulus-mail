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
        // Counted in bytes as it arrives, so a body with no length (chunked) is not read past the cap.
        const chunks: Uint8Array[] = [];
        let size = 0;
        const reader = request.body?.getReader();
        while (reader) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_BODY) {
            await reader.cancel().catch(() => undefined);
            return new Response("Too large", { status: 413 });
          }
          chunks.push(value);
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        const text = new TextDecoder().decode(bytes);
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
          const { TenantAccessError } = await import("@/lib/storage");
          const message = error instanceof Error ? error.message : "";
          if (message === FACTOR_REQUIRED) return new Response(message, { status: 403 });
          if (error instanceof TenantAccessError) return new Response("Forbidden", { status: 403 });
          if (error instanceof Error && error.name === "RateLimitedError") return new Response(message, { status: 429 });
          // A limit or a bad field, or a failure on our side: the page is gone and cannot retry either way.
          return new Response("Not saved", { status: 400 });
        }
        return new Response(null, { status: 204 });
      },
    },
  },
});
