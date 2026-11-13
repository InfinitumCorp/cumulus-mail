import { createFileRoute } from "@tanstack/react-router";

/**
 * Run the scheduled jobs once (see src/lib/mail/cron.server.ts). For the Russia copy's scheduler: a
 * Yandex timer or a VM cron calling this every minute with `Authorization: Bearer <CRON_SECRET>`.
 * 404 unless CRON_SECRET is set, 401 without the right token. Answers counts only.
 */
export const Route = createFileRoute("/api/cron/tick")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { cronDecision } = await import("@/lib/cron-auth");
        const decision = cronDecision(request.headers.get("authorization"));
        if (decision === "off") return new Response("Not found", { status: 404 });
        if (decision === "denied") return new Response("Unauthorized", { status: 401 });
        const { runScheduledJobs } = await import("@/lib/mail/cron.server");
        const report = await runScheduledJobs();
        console.log(JSON.stringify({ event: "mail.schedule.ran", via: "http", ...report }));
        return Response.json(report, { headers: { "cache-control": "no-store" } });
      },
    },
  },
});
