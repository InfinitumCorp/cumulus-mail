import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCsp, CSP_REPORTING_ENDPOINTS } from "./csp.ts";
import { createReportBudget, MAX_REPORT_BYTES, MAX_REPORTS_PER_REQUEST, parseCspReports, readCappedText, scrubPath } from "./csp-report.ts";
import { metricLine } from "./observability/metrics.ts";

test("the policy reports violations to this origin, both ways browsers do it", () => {
  const policy = buildCsp({ nonce: "abc" });
  assert.match(policy, /; report-uri \/api\/csp-report; report-to csp$/);
  assert.equal(CSP_REPORTING_ENDPOINTS, 'csp="/api/csp-report"');
});

test("report-uri format (Firefox, Safari): directive, blocked origin only, scrubbed path", () => {
  const body = JSON.stringify({
    "csp-report": {
      "document-uri": "https://mail.cumuluscloud.app/p/0123456789abcdef0123456789abcdef?x=secret#frag",
      "violated-directive": "script-src-elem",
      "effective-directive": "script-src-elem",
      "blocked-uri": "https://evil.example/path/payload.js?token=abc",
      "disposition": "enforce",
    },
  });
  assert.deepEqual(parseCspReports(body, "application/csp-report"), [
    { directive: "script-src-elem", blocked: "https://evil.example", path: "/p/:token", disposition: "enforce" },
  ]);
});

test("Reporting API format (Chromium): only csp-violation entries; keywords kept as keywords", () => {
  const body = JSON.stringify([
    { type: "csp-violation", url: "https://mail.cumuluscloud.app/", body: { documentURL: "https://mail.cumuluscloud.app/?folder=sent", effectiveDirective: "style-src-elem", blockedURL: "inline", disposition: "report" } },
    { type: "deprecation", body: { id: "x" } },
    { type: "csp-violation", body: { documentURL: "https://mail.cumuluscloud.app/", effectiveDirective: "img-src", blockedURL: "data:image/png;base64,AAAA" } },
  ]);
  assert.deepEqual(parseCspReports(body, "application/reports+json"), [
    { directive: "style-src-elem", blocked: "inline", path: "/", disposition: "report" },
    { directive: "img-src", blocked: "data", path: "/", disposition: "enforce" },
  ]);
});

test("nothing personal survives: addresses, ids and long tokens in the path are replaced", () => {
  assert.equal(scrubPath("https://x/legal/privacy"), "/legal/privacy");
  assert.equal(scrubPath("https://x/u/ada@example.org/inbox"), "/u/:id/inbox");
  assert.equal(scrubPath("https://x/thread/12345"), "/thread/:id");
  assert.equal(scrubPath("https://x/search?q=salary"), "/search", "no query");
  // And the metric line itself redacts anything address-like that slipped into a field.
  assert.equal(metricLine("csp.violation", { blocked: "mailto:ada@example.org" }).blocked, "[redacted]");
});

test("malformed, oversized and flooding bodies are bounded", () => {
  assert.deepEqual(parseCspReports("not json", "application/csp-report"), []);
  assert.deepEqual(parseCspReports(JSON.stringify({ "csp-report": { "violated-directive": "<script>" } }), null), [], "a directive must look like one");
  assert.deepEqual(parseCspReports("x".repeat(MAX_REPORT_BYTES + 1), null), []);
  const many = JSON.stringify(Array.from({ length: 50 }, () => ({ type: "csp-violation", body: { effectiveDirective: "img-src", blockedURL: "https://a.example/x" } })));
  assert.equal(parseCspReports(many, "application/reports+json").length, MAX_REPORTS_PER_REQUEST);
});

test("the per-minute budget drops the excess and says how many it dropped", () => {
  let clock = 0;
  const budget = createReportBudget(2, () => clock);
  assert.deepEqual([budget.take(), budget.take(), budget.take(), budget.take()].map((r) => r.ok), [true, true, false, false]);
  clock = 60_000;
  assert.deepEqual(budget.take(), { ok: true, droppedBefore: 2 });
  assert.deepEqual(budget.take(), { ok: true, droppedBefore: 0 });
});

test("a chunked body with no Content-Length is read only up to the cap, never buffered whole", async () => {
  let pulled = 0;
  const chunk = new Uint8Array(4096).fill(65);
  const endless = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled += 1;
      controller.enqueue(chunk);
    },
  });
  const request = new Request("http://localhost/api/csp-report", { method: "POST", body: endless, duplex: "half" } as RequestInit);
  assert.equal(await readCappedText(request, MAX_REPORT_BYTES), null, "over the cap");
  assert.ok(pulled <= MAX_REPORT_BYTES / chunk.byteLength + 2, `stopped reading after ${pulled} chunks`);
  const small = new Request("http://localhost/", { method: "POST", body: '{"csp-report":{}}' });
  assert.equal(await readCappedText(small), '{"csp-report":{}}');
  assert.equal(await readCappedText(new Request("http://localhost/", { method: "POST" })), "");
});
