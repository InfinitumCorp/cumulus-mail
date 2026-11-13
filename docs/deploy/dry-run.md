# Deploy dry run and first-deploy checklist

What to run before the first real deploy of each copy, and what was found the first time it was run
(2026-11-13, main at `d7c0de0`).

## US copy (Cloudflare Workers)

```sh
npm ci
npm run deploy:dry-run        # both workers; or: npm run deploy:dry-run -- api
```

The command does exactly what "Deploy US (Cloudflare)" does, except upload:
1. `npm run build:workers`;
2. `scripts/deploy-guard.mjs`, with a dummy Hyperdrive id;
3. `wrangler@4.157.0 deploy --dry-run --outdir .output/dry-run/<worker>`.

It then checks what wrangler's dry run doesn't: **every module the API worker imports is in the upload**, and the compressed size is under the Workers limit.

**Result on 2026-11-13: ok.**
| Worker | Upload |
|---|---|
| api | 91 modules, 1.98 MiB gzip |
| inbound | 1 module, 0.99 MiB gzip |

No Cloudflare login is needed.

### Found and fixed on the first run
The guard re-read Nitro's `wrangler.json` with a regex comment stripper. The stripper turned the module glob `"**/*.mjs", "**/*.js"` into `"***.js"`, so the guarded config uploaded **only `index.mjs` (43 KiB)**. Run locally, the worker failed on start with `No such module "_libs/h3+rou3+srvx.mjs"`. Every request to the deployed API worker would have failed.

`parseJsonc` (`scripts/nitro-preset.mjs`) is now string-aware, and tests cover both the parser and the guarded config.

### Optional: run the built API worker locally
```sh
node scripts/dry-run/fake-s3.mjs 59000 &        # in-memory S3 stand-in
cd .output/server
CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE=postgres://… \
npx wrangler@4.157.0 dev --config wrangler.deploy.json --local --port 8790 \
  --var SUPABASE_S3_ENDPOINT:http://127.0.0.1:59000 --var SUPABASE_S3_ACCESS_KEY_ID:x \
  --var SUPABASE_S3_SECRET_ACCESS_KEY:x --var MAIL_S3_LOOPBACK_ONLY:1 \
  --var MAIL_BLOB_KEY:<64 hex> --var BETTER_AUTH_SECRET:<random> --var BETTER_AUTH_URL:http://127.0.0.1:8790
node scripts/smoke.mjs --host http://127.0.0.1:8790 --region us
```

**What this shows:**
- the worker starts;
- the page, the static assets and the JS chunks are served;
- storage answers;
- the sign-in redirect goes to `id.cumuluscloud.app` with PKCE and a callback on this host.

**What it can't show:** the database. Wrangler's *local* Hyperdrive emulation adds `sslmode=disable` to the connection string, and the app refuses that on purpose (`src/lib/pg-connection.ts`). That makes `pg` over Workers sockets through real Hyperdrive the one part never run before production. Hence step 1 below.

## Russia copy (Yandex Serverless Container)

```sh
docker build --build-arg APP_COMMIT=$(git rev-parse --short=12 HEAD) -t cumulus-mail-ru:dryrun .
DATABASE_URL=postgres://… node scripts/migrate.mjs     # a scratch Postgres
docker run -d -p 127.0.0.1:18080:8080 --env-file ru.env -e MAIL_REGION=ru cumulus-mail-ru:dryrun
node scripts/smoke.mjs --host http://127.0.0.1:18080 --region ru
```

`ru.env` holds the plain settings from `deploy/yandex/ru.env.example` plus:
- dummy secrets;
- a scratch `DATABASE_URL`;
- either `MAIL_STORAGE=local` or the `MAIL_S3_*` settings pointing at the fake S3.

**Result on 2026-11-13: ok.** With Postgres, and with both filesystem and S3 storage:
- health ok, region `ru`, commit stamped, schema current;
- not behind API Gateway or Cloudflare;
- page 200;
- sign-in goes to `ru.id.cumuluscloud.app` with PKCE;
- Docker's own HEALTHCHECK is `healthy`;
- the process runs as `node` (uid 1000), not root;
- the image is 374 MB.

`APP_COMMIT` must be a hex commit id (`deploy.sh` passes `git rev-parse`). Anything else is reported as `unknown`, which fails the smoke check's commit test.

## Not covered by the dry run: a real send
Every send path needs things a dry run doesn't have:
- the US cron needs the database, which the local emulation refuses (above);
- the Russia copy has no scheduler on main until #88;
- a direct send needs a signed-in session.

The SMTP client itself is covered by the outbound unit tests, including STARTTLS against a local server. Send once by hand after the first deploy (step 4 below).

## First real deploy: checklist
1. `npm run deploy:dry-run` is green on the commit being deployed.
2. Run "Deploy US", then `node scripts/smoke.mjs --host https://cumulus-mail-api.<account>.workers.dev --region us`. **Health must say `db: ok`, `source: postgres`**: this is the first time `pg` runs through real Hyperdrive. If it says `unreachable`, read the worker's logs (observability is on) before anything else.
3. Run "Deploy RU", then `node scripts/smoke.mjs --host https://<id>.apigw.yandexcloud.net --region ru`, then the same against `ru.mail.cumuluscloud.app` after DNS.
4. Sign in on each copy and send one message to an outside mailbox. Check the delivery, the DKIM pass and the copy in Sent.
5. `npm run db:status` against each copy's database: 0 pending.
