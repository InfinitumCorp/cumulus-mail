/**
 * Inbound email for Cumulus://Mail, on the same Worker as the mailbox API.
 *
 * Nitro's Cloudflare handler exports `fetch`, `scheduled` and `email`, and its
 * `email()` calls the `cloudflare:email` runtime hook. So Cloudflare Email
 * Routing delivers straight into this app: Email Routing -> this Worker ->
 * `handleEmail` -> Postgres (`cumulus_mail`) + the private Supabase Storage
 * bucket. There is no second Worker and no queue in between.
 *
 * Auto-registered because vite.config.ts sets `serverDir: "./server"`; Nitro v3
 * scans `server/plugins/`. Without that option this file is never loaded and
 * inbound mail is silently dropped.
 *
 * `workers/email/src/index.ts` stays the handler: it owns recipient matching,
 * MIME parsing and the SPF/DKIM/DMARC check. This file only supplies the
 * bindings it asks for. Both are imported lazily so the API path does not pay
 * for the MIME and mail-auth code on a cold start.
 *
 * There is no send binding here, and outbound mail stays held. Do not add one.
 */
import { definePlugin } from "nitro";

export default definePlugin((nitro) => {
  nitro.hooks.hook("cloudflare:email", async ({ message }) => {
    const [{ handleEmail }, { openIngest }] = await Promise.all([
      import("../../workers/email/src/index.ts"),
      import("../../src/lib/mail/ingest.server.ts"),
    ]);
    try {
      const ingest = await openIngest();
      await handleEmail(
        { from: message.from, to: message.to, raw: message.raw },
        {
          ingest,
          MAIL_DOMAIN: process.env.MAIL_DOMAIN,
          MAIL_APP_HOST: process.env.MAIL_APP_HOST,
          MAIL_AUTH_DNS: process.env.MAIL_AUTH_DNS,
        },
      );
    } catch (error) {
      // Email Routing retries a rejected message; a silent success would lose
      // it. Surfacing the error keeps the delivery attempt visible in the
      // Worker's logs with the setting that is missing.
      console.error("[mail] inbound ingest failed:", error);
      throw error;
    }
  });
});
