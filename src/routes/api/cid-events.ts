import { createFileRoute } from "@tanstack/react-router";

// Cumulus://ID account events (mailbox provisioning, security notices). Server-to-server: no CORS.
export const Route = createFileRoute("/api/cid-events")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { receiveCidEvent } = await import("@/lib/mail/mailbox.server");
        const body = await request.text();
        const out = await receiveCidEvent(body, request.headers.get("x-cid-signature"));
        return new Response(out.result ? JSON.stringify({ result: out.result }) : null, {
          status: out.status,
          headers: { "content-type": "application/json", "cache-control": "no-store" },
        });
      },
    },
  },
});
