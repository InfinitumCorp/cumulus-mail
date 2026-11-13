# Content-Security-Policy

Every HTML page from a production build carries a strict, nonce-based policy (`src/lib/csp.ts`, set in `src/start.ts`).

## The policy
- **Scripts:** this origin, plus the response's nonce. TanStack Router puts that nonce on its own inline bootstrap.
- **No third-party origins.** No `unsafe-inline` for scripts, no `unsafe-eval`. Zod runs `jitless` (`src/lib/zod-config.ts`), because its JIT probe calls `new Function`.
- **`frame-ancestors 'none'`.**
- **Alongside it** (#87): HSTS on https, `Referrer-Policy` and `Permissions-Policy`.

**The one exception:** while the platform extensions script is on (`VITE_GROK_EXTENSIONS`, not `0`), `script-src` also allows exactly `https://grok.com/grok-app-builder/extensions.js`. Nothing else on that host, and **never on the Russia copy**.

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
