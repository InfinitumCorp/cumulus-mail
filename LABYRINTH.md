# Mail → Labyrinth

By **Infinitum Corporation®**. The app-data SDK exports `createMailLabyrinth`;
`server/middleware/labyrinth.ts` mounts a same-origin `/api/labyrinth` relay.
Configure the server's `LBRNTH_ENDPOINT` to the authoritative Nexus CID-backed
repository endpoint. No configuration means 503. The client requires an explicit
Cumulus ID/repository token callback; missing credentials mean no network request.

The current Mail app's Better Auth/Grok broker/preview identity is **not Cumulus ID**.
It is not joined by email, user id or a dev fallback. Sign in separately to the
Cumulus ID authority using its existing passkey/MFA/social/SSO flow and explicitly
approve LBRNTH scopes. A direct authenticated CID session can obtain a 15-minute
repository-only bearer using the central client's `sessionToken()` operation.
It is linked to parent-session revocation and cannot renew itself or grant consent.
Keep it in memory and supply it to the Mail client's `token` callback. Browser
popup/PKCE login handoff UI is a follow-on; this PR does not replace Mail's login.

Explicit `save`/`load` operations use `products/cumulus-mail/...` paths and retain
branch-head CAS. No mail, contacts, attachments or drafts are automatically copied.
The central service derives org/role from real CID state and requires a live paid
LBRNTH entitlement plus CID consent and team membership for every operation.
The relay requires CID bearer even in preview/dev mode; no app cookie becomes CID.
Body limits, HTTPS, no redirects, timeouts and no-store responses are enforced.

## Review blockers inherited from this repository

The full existing `npm test` script currently reports 16 failing platform/template
script tests (181/197 pass), including absent `.grok/skills` and template app-env
fixtures plus existing OG/chrome expectations. Those scripts/fixtures were not
changed or weakened by this integration. The TypeScript/unit group and new
Labyrinth tests are run separately; `npm run typecheck` passes.

The unchanged dependency lock reports 12 advisories, including a critical
Better Auth OAuth-state advisory and high Zod availability advisory. This feature
adds no dependencies or dependency upgrades. Resolve baseline vulnerabilities
and template tests separately before merging/deploying this **draft** integration.
No production/site/Vercel changes, deployments or merges are performed.
