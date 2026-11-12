import { createFileRoute } from "@tanstack/react-router";

/** Liveness and dependency check for each region's copy. No secrets, no auth needed. */
export const Route = createFileRoute("/api/health")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { healthForRequest } = await import("@/lib/health.server");
        const report = await healthForRequest(request);
        return Response.json(report, {
          status: report.status === "ok" ? 200 : 503,
          headers: { "cache-control": "no-store" },
        });
      },
    },
  },
});
