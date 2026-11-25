# Content-Security-Policy

Every HTML page from a production build carries a strict, nonce-based policy (`src/lib/csp.ts`, set in `src/start.ts`).

## The policy
- **Scripts:** this origin, plus the response's nonce. TanStack Router puts that nonce on its own inline bootstrap.
- **No third-party origins.** No `unsafe-inline` for scripts, no `unsafe-eval`. No zod in the browser bundle (its JIT probe calls `new Function`); the preview bridge checks its messages by hand.
- **`frame-ancestors 'none'`.**
- **Alongside it** (#87): HSTS on https, `Referrer-Policy` and `Permissions-Policy`.

**The platform extensions script is off.** It is off unless a deployer sets `VITE_GROK_EXTENSIONS=1`, and both deploy workflows and the Dockerfile set `0` (owner decision, 2026-11-16), so no page loads a script from grok.com and `script-src` has no allowance for it. `npm run csp:check` fails if a page or its CSP header mentions grok.com. If it were ever switched on, `script-src` would allow exactly `https://grok.com/grok-app-builder/extensions.js`, nothing else on that host, and **never on the Russia copy**.

## Staging it: `MAIL_CSP`
| Value | Effect |
|---|---|
| unset | `enforce` in a production build. The dev server never sends a CSP (Vite injects inline scripts). |
| `report-only` | Sends `Content-Security-Policy-Report-Only`. Browsers log violations in the console and block nothing. |
| `enforce` | Sends `Content-Security-Policy`. |
| `off` | No header. |

To stage it on a copy:
1. Deploy with `MAIL_CSP=report-only`.
2. Use the app with the browser console open; any "[Report Only] Refused to …" line is a violation.
3. Deploy with `MAIL_CSP` removed (enforce).

## Checked in CI
`npm run csp:check` (CI `perf` job) runs the production build with the policy **enforced**. It opens the mail list, a message, compose, calendar, contacts and a share page in Chromium, and fails on any `securitypolicyviolation`.

Locally:
```sh
VITE_AUTH_ENABLED=false npm run build:node
npm run csp:check
```

## Violation reports
Every page names a report endpoint: `report-uri /api/csp-report` (Firefox, Safari) and `report-to csp` with a `Reporting-Endpoints: csp="/api/csp-report"` header (Chromium, which batches reports and may send them up to a minute later). Each report becomes one `csp.violation` metric line: the directive, where the blocked thing came from (an origin or a keyword such as `inline`, never a full URL), the page path with tokens and ids replaced, and `enforce` or `report`. No query strings, no addresses. A request carries at most 10 reports, and each copy writes at most 120 lines a minute; the next line after a drop says how many were dropped.

So both stages are visible in the logs:
- under `MAIL_CSP=report-only`, the lines show what *would* be blocked, before you turn enforcement on;
- under `enforce`, they show what *is* blocked, with an alert (`docs/ops/alerts.md`, "CSP blocking something").

`npm run csp:check` checks that every page names the endpoint and that reports posted there become lines.

