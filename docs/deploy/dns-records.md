# DNS records for mail

What the owner must create, per domain. **Docs only: nothing here has been created, and no DNS was changed.** Values in `<angle brackets>` are decisions or values only the owner has. Each is marked with what it depends on.

Check what's published with `dig TXT <name> +short` (or `nslookup -type=TXT`). The tests in `src/lib/mail/outbound/deliverability.test.ts` verify a signed message against records of exactly this form.

## US copy: `cumuluscloud.app`
| # | Name | Type | Value | Notes |
|---|---|---|---|---|
| 1 | `cumuluscloud.app` | MX | `route1.mx.cloudflare.net` (10), `route2…` (20), `route3…` (30) | **Created by Cloudflare Email Routing** when it's enabled for the zone. Check they're there; don't add others. |
| 2 | `cumuluscloud.app` | TXT | `v=spf1 include:<relay SPF include> ~all` | `<relay>`: the SMTP relay behind `MAIL_SMTP_HOST` (`docs/deploy/outbound-smtp.md`). Use the provider's documented `include:`. Start with `~all`; move to `-all` once DMARC reports show nothing else sends as this domain. **Keep a single SPF record:** if one exists, merge into it. |
| 3 | `<selector>._domainkey.cumuluscloud.app` | TXT | from `npm run dkim:record -- dkim.pem <selector> cumuluscloud.app` | `<selector>`: e.g. `cm2026` (a new name per key makes rotation easy). The command prints the value already split into ≤255-character strings, which a 2048-bit key needs. Then set `MAIL_DKIM_SELECTOR` and `MAIL_DKIM_PRIVATE_KEY` (a Worker secret) on the inbound worker. |
| 4 | `_dmarc.cumuluscloud.app` | TXT | `v=DMARC1; p=none; rua=mailto:<reports address>; adkim=s; aspf=r` | Start at `p=none` and read the aggregate reports for 2–4 weeks. Then `p=quarantine`, then `p=reject`. `adkim=s` works because we sign with `d=cumuluscloud.app` exactly. `<reports address>`: a mailbox that exists, ideally a separate one. |
| 5 | `_mta-sts.cumuluscloud.app` | TXT | `v=STSv1; id=<yyyymmdd01>` | Change `id` whenever the policy file changes. |
| 6 | `mta-sts.cumuluscloud.app` | CNAME/A + HTTPS | serves `https://mta-sts.cumuluscloud.app/.well-known/mta-sts.txt` | Policy file, plain text: `version: STSv1` / `mode: testing` / `mx: *.mx.cloudflare.net` / `max_age: 86400`. After a clean TLS-RPT week, set `mode: enforce` and `max_age: 604800`. It needs a valid certificate and must not redirect. |
| 7 | `_smtp._tls.cumuluscloud.app` | TXT | `v=TLSRPTv1; rua=mailto:<reports address>` | TLS failure reports for MTA-STS. |

Already in place and covered elsewhere: the app host `mail.cumuluscloud.app` (`docs/deploy/cutover.md`).

## Russia copy
Depends on **D3** (`docs/deploy/yandex-ru.md`): how Russian mailboxes receive mail.

**If Russian mailboxes share `@cumuluscloud.app`:** inbound stays on the US MX above, and there are no new MX records. If the Russia copy sends through its own relay (outbound from Russia), it needs:

| # | Name | Type | Value | Notes |
|---|---|---|---|---|
| 1 | `cumuluscloud.app` | TXT (SPF) | add `include:<RU relay SPF include>` to the **same** record as US #2 | One SPF record per name, under the 10-lookup limit. |
| 2 | `<ru selector>._domainkey.cumuluscloud.app` | TXT | `npm run dkim:record -- dkim-ru.pem <ru selector> cumuluscloud.app` | A separate key and selector (e.g. `cmru2026`), so each copy holds only its own private key and rotates on its own. The key goes in Lockbox (`MAIL_DKIM_PRIVATE_KEY`). |

DMARC, MTA-STS and TLS-RPT stay as in the US table (one per domain).

**If Russian mailboxes get their own mail domain or subdomain** (e.g. `ru.cumuluscloud.app`, with inbound in Russia), repeat US #2–#7 for that name, plus:

| # | Name | Type | Value | Notes |
|---|---|---|---|---|
| 1 | `<ru mail domain>` | MX | `<RU inbound host>` (10) | The host that receives Russian mail, in Russia. It doesn't exist yet (D3). |

`MAIL_DOMAIN` on the Russia copy then becomes that domain, and the DKIM `d=` follows it (`MAIL_DKIM_DOMAIN`).

## Customer custom domains
Each customer domain needs its own MX/SPF/DKIM, but we don't sign for it (`docs/deploy/outbound-smtp.md`). The in-app domain check lists what that customer must publish.

## Order of work
1. **SPF and DKIM** (US #2 and #3) before the first outbound send.
2. **DMARC at `p=none`** (US #4) on the same day.
3. **MTA-STS and TLS-RPT in `testing`** (US #5–#7) after inbound works.
4. **Tighten** DMARC to `quarantine`/`reject` and MTA-STS to `enforce` after the reports are clean.
