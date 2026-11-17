# Rate limits at the edge (owner, Cloudflare dashboard)

The app limits abusable actions itself (`src/lib/rate-limit.ts`: exports, imports, shares, spam reports,
deletion requests, SCALVS briefs; sign-in through Better Auth). Those limits are **in memory, per
instance**. On Cloudflare Workers every isolate keeps its own count, so they stop a loop or a script but not a
flood spread across many isolates or IPs. A rule at the edge closes that gap. **Nothing here is in the
repository's deploy**: it is a zone setting the owner adds once.

**Where:** Cloudflare dashboard → zone `cumuluscloud.app` → Security → WAF → **Rate limiting rules**. The rules
apply once `mail.cumuluscloud.app` points at `cumulus-mail-api` (`docs/launch/friday.md` step 6). The Russia
copy is not behind Cloudflare; on Yandex, the API Gateway's own request limits play this part.

## Rules
Start with **log** (Cloudflare's "Log" action, on paid plans) for a day, check nothing legitimate is caught,
then switch to **block**. Count by IP. The numbers are starting points, well above what one person does.

| # | Name | When incoming requests match | Rate | Then |
|---|---|---|---|---|
| 1 | Sign-in | `http.host eq "mail.cumuluscloud.app" and starts_with(http.request.uri.path, "/api/auth/") and http.request.method eq "POST"` | 20 per minute | block for 10 minutes |
| 2 | App calls | `http.host eq "mail.cumuluscloud.app" and starts_with(http.request.uri.path, "/_serverFn/")` | 300 per minute | block for 1 minute |
| 3 | Data downloads | `http.host eq "mail.cumuluscloud.app" and starts_with(http.request.uri.path, "/api/account/export/")` | 10 per minute | block for 10 minutes |
| 4 | CSP reports | `http.host eq "mail.cumuluscloud.app" and http.request.uri.path eq "/api/csp-report"` | 60 per minute | block for 1 minute |

Notes:
- **Block, not challenge.** These are API calls made by the app's script; a person never sees a challenge
  page on them, so a challenge would just break the app for that IP.
- **Plans.** The Free plan allows one rate-limiting rule with a 10-second period. If that is the plan, keep
  rule 2 (scale it: 50 per 10 seconds); it covers every app action, including SCALVS briefs.
- **Shared IPs.** Offices and mobile carriers put many people behind one address. Rule 2's 300 a minute
  allows for that; lower it only after looking at the logged matches.
- **What a block looks like** to the app: a 429 from Cloudflare. The app shows its sync-error notice, and the
  next change the person makes saves the whole mailbox again, so nothing is lost once the block ends.

## Check
After adding the rules, with `npm run smoke -- --url https://mail.cumuluscloud.app` still all ok (the smoke
makes a handful of requests, far under every limit), and in Security → Events, the rules appear with zero
matches during normal use.
