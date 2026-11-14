/**
 * CSP violation reports (src/routes/api/csp-report.ts). Browsers POST them when the policy in csp.ts
 * blocks something (or would, under MAIL_CSP=report-only). Each becomes one `csp.violation` metric line,
 * so a page the policy breaks in production shows up in the logs and the alert (docs/ops/alerts.md)
 * instead of only in some user's console.
 *
 * Two formats arrive: `application/csp-report` (report-uri; Firefox, Safari) and
 * `application/reports+json` (report-to / Reporting API; Chromium). Only what is needed to find the
 * cause is kept, and nothing personal: the directive, where the blocked thing came from (an origin or a
 * keyword such as `inline`, never a full URL with its path or query), the page path with tokens and ids
 * scrubbed, and whether it was enforced.
 */
export type CspViolation = {
  directive: string;
  /** An origin (`https://example.org`) or a keyword: inline, eval, data, blob, self, wasm-eval, trusted-types-sink, other. */
  blocked: string;
  /** The page's path, with tokens and ids replaced (`/p/:token`). */
  path: string;
  disposition: "enforce" | "report";
};

/** Reports kept from one request; the rest are dropped (a page cannot flood the logs). */
export const MAX_REPORTS_PER_REQUEST = 10;
/** Bytes accepted in one request. */
export const MAX_REPORT_BYTES = 16 * 1024;

const KEYWORDS = new Set(["inline", "eval", "data", "blob", "self", "wasm-eval", "trusted-types-sink", "trusted-types-policy"]);

function blockedSource(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return "other";
  if (KEYWORDS.has(text)) return text;
  if (/^(data|blob):/i.test(text)) return text.slice(0, text.indexOf(":")).toLowerCase();
  try {
    const url = new URL(text);
    if (url.protocol === "http:" || url.protocol === "https:" || url.protocol === "wss:" || url.protocol === "ws:") return url.origin;
    return url.protocol.replace(/:$/, "") || "other";
  } catch {
    return "other";
  }
}

/** A page path without query or hash, with share tokens, long ids and numbers replaced. */
export function scrubPath(value: unknown): string {
  const text = typeof value === "string" ? value : "";
  let path: string;
  try {
    path = new URL(text, "https://placeholder.invalid").pathname;
  } catch {
    return "/";
  }
  return (
    path
      .split("/")
      .map((part) => (/^[A-Za-z0-9_-]{16,}$/.test(part) || /\d{3,}/.test(part) || part.includes("@") ? ":id" : part))
      .join("/")
      .replace(/^\/p\/:id$/, "/p/:token")
      .slice(0, 120) || "/"
  );
}

function directiveOf(value: unknown): string | null {
  const text = typeof value === "string" ? value.trim().split(/\s+/)[0]!.toLowerCase() : "";
  return /^[a-z-]{3,40}$/.test(text) ? text : null;
}

function one(raw: Record<string, unknown> | undefined, kind: "legacy" | "reporting"): CspViolation | null {
  if (!raw || typeof raw !== "object") return null;
  const directive =
    kind === "legacy" ? directiveOf(raw["effective-directive"]) ?? directiveOf(raw["violated-directive"]) : directiveOf(raw.effectiveDirective);
  if (!directive) return null;
  const blocked = blockedSource(kind === "legacy" ? raw["blocked-uri"] : raw.blockedURL);
  const path = scrubPath(kind === "legacy" ? raw["document-uri"] : raw.documentURL);
  const disposition = raw.disposition === "report" ? "report" : "enforce";
  return { directive, blocked, path, disposition };
}

/** The violations in a report request body (either format). Malformed input gives an empty list. */
export function parseCspReports(text: string, contentType: string | null): CspViolation[] {
  if (!text || text.length > MAX_REPORT_BYTES) return [];
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return [];
  }
  const out: CspViolation[] = [];
  const type = (contentType ?? "").toLowerCase();
  if (Array.isArray(body) || type.includes("reports+json")) {
    for (const item of Array.isArray(body) ? body : [body]) {
      if (item && typeof item === "object" && (item as { type?: unknown }).type === "csp-violation") {
        const v = one((item as { body?: Record<string, unknown> }).body, "reporting");
        if (v) out.push(v);
      }
      if (out.length >= MAX_REPORTS_PER_REQUEST) break;
    }
  } else if (body && typeof body === "object" && "csp-report" in body) {
    const v = one((body as { "csp-report"?: Record<string, unknown> })["csp-report"], "legacy");
    if (v) out.push(v);
  }
  return out.slice(0, MAX_REPORTS_PER_REQUEST);
}

/**
 * A per-isolate cap on how many violation lines are written per minute, so a broken (or hostile) page
 * cannot flood the logs. Over the cap, reports are counted and summarised in the next line instead.
 */
export function createReportBudget(perMinute = 120, now: () => number = Date.now) {
  let windowStart = now();
  let used = 0;
  let dropped = 0;
  return {
    take(): { ok: boolean; droppedBefore: number } {
      if (now() - windowStart >= 60_000) {
        windowStart = now();
        used = 0;
      }
      if (used >= perMinute) {
        dropped += 1;
        return { ok: false, droppedBefore: 0 };
      }
      used += 1;
      const droppedBefore = dropped;
      dropped = 0;
      return { ok: true, droppedBefore };
    },
  };
}
