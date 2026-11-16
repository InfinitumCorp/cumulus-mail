import { createFileRoute } from "@tanstack/react-router";
import { createReportBudget, MAX_REPORT_BYTES, parseCspReports, readCappedText } from "@/lib/csp-report";
import { metric } from "@/lib/observability/metrics";

const budget = createReportBudget();

/**
 * Where browsers send Content-Security-Policy violation reports (csp.ts: report-uri and report-to).
 * Each becomes a `csp.violation` metric line (docs/ops/alerts.md). No auth: reports carry no cookies,
 * and nothing here reads or changes mail. Always 204, so a client learns nothing from the answer.
 */
export const Route = createFileRoute("/api/csp-report")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const declared = Number(request.headers.get("content-length") ?? 0);
        if (declared > MAX_REPORT_BYTES) return new Response(null, { status: 413 });
        // Read at most MAX_REPORT_BYTES even without a Content-Length (a chunked body): never buffer more.
        const text = await readCappedText(request, MAX_REPORT_BYTES);
        if (text === null) return new Response(null, { status: 413 });
        for (const violation of parseCspReports(text, request.headers.get("content-type"))) {
          const { ok, droppedBefore } = budget.take();
          if (!ok) continue;
          metric("csp.violation", { ...violation, ...(droppedBefore ? { droppedBefore } : {}) });
        }
        return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
      },
    },
  },
});
