import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { createS3Driver } from "../storage/driver.ts";
import { openTenantStorage } from "../storage/index.ts";
import { signedInbound } from "./auth-fixture.ts";
import { exportMailbox, importMailbox } from "./backup.ts";
import type { TenantStorage } from "./delivery.ts";
import { messageSnippet } from "./logic.ts";
import { listThreads } from "./logic.ts";
import { openMailbox, readAttachment } from "./mailbox.ts";
import type { MailQuery } from "./query.ts";
import { profile } from "./test-support.ts";
import { handleEmail } from "../../../workers/email/src/index.ts";

const databaseUrl = process.env.MAIL_RUNTIME_DATABASE_URL?.trim();
const s3Endpoint = process.env.MAIL_S3_ENDPOINT?.trim();
const ready = Boolean(databaseUrl && s3Endpoint);

if (!process.env.MAIL_BLOB_KEY) process.env.MAIL_BLOB_KEY = "ab".repeat(32);

test(
  "inbound mail is authenticated, stored, fetched, isolated, and restored",
  { skip: ready || process.env.CI ? false : "postgres and minio are not configured" },
  async () => {
    if (!databaseUrl || !s3Endpoint) throw new Error("CI requires MAIL_RUNTIME_DATABASE_URL and MAIL_S3_ENDPOINT");
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    const migrationsDir = fileURLToPath(new URL("../../../migrations/", import.meta.url));
    for (const name of readdirSync(migrationsDir).filter((file) => file.endsWith(".sql")).sort()) {
      await client.query(readFileSync(join(migrationsDir, name), "utf8"));
    }
    const db: MailQuery = {
      query: async <T>(text: string, params: unknown[] = []) => {
        const result = await client.query(text, params);
        return result.rows as T[];
      },
    };
    const driver = createS3Driver({
      endpoint: s3Endpoint,
      region: process.env.MAIL_S3_REGION?.trim() || "us-east-1",
      bucket: process.env.MAIL_S3_BUCKET?.trim() || "cumulus-mail",
      accessKeyId: process.env.MAIL_S3_ACCESS_KEY_ID?.trim() || "cumulus",
      secretAccessKey: process.env.MAIL_S3_SECRET_ACCESS_KEY?.trim() || "cumulussecret",
      loopbackOnly: true,
    });
    await driver.ensureBucket();
    const storageFor: TenantStorage = (tenantId) => openTenantStorage(tenantId, driver);
    const suffix = randomBytes(4).toString("hex");
    const adaId = `rt-ada-${suffix}`;
    const beaId = `rt-bea-${suffix}`;
    const copyId = `rt-copy-${suffix}`;
    const adaEmail = `ada.${suffix}@cumuluscloud.app`;
    const beaEmail = `bea.${suffix}@cumuluscloud.app`;
    try {
      await openMailbox(db, adaId, profile(adaId, adaEmail, "Ada"));
      await openMailbox(db, beaId, profile(beaId, beaEmail, "Bea"));
      const { raw, resolver } = await signedInbound({
        from: "Mira Chen <mira.chen@example.test>",
        to: `Ada <${adaEmail}>`,
        subject: "Forecast",
        text: "The forecast holds.",
        filename: "note.txt",
        attachment: "forecast-bytes",
      });
      const stored = await handleEmail(
        { from: "mira.chen@example.test", to: adaEmail, raw },
        {
          ingest: { db, storageFor },
          resolver,
          MAIL_DOMAIN: "cumuluscloud.app",
        },
      );
      assert.equal(stored.stored.length, 1);

      const snapshot = await openMailbox(db, adaId, profile(adaId, adaEmail, "Ada"));
      const message = snapshot.messages.find((item) => item.subject === "Forecast");
      assert.ok(message);
      assert.equal(message.folder, "inbox");
      assert.equal(message.auth?.spf, "pass");
      assert.equal(message.auth?.dkim, "pass");
      assert.equal(message.auth?.dmarc, "pass");
      assert.equal(message.auth?.disposition, "deliver");
      const rows = listThreads(snapshot.messages, "inbox", "", false);
      assert.equal(rows[0]?.subject, "Forecast");
      assert.match(messageSnippet(rows[0]?.body ?? ""), /holds/);
      const file = message.attachments?.[0];
      assert.ok(file?.id);
      const downloaded = await readAttachment(db, storageFor(adaId), adaId, message.id, file.id);
      assert.equal(new TextDecoder().decode(downloaded?.bytes), "forecast-bytes");

      const sealed = await db.query<{ subject: string; body: string; raw_key: string }>(
        `select subject, body, raw_key from cumulus_mail.messages where tenant_id = $1 and id = $2`,
        [adaId, message.id],
      );
      assert.equal(sealed[0]?.subject.includes("Forecast"), false);
      assert.equal(sealed[0]?.body.includes("holds"), false);
      const onS3 = await driver.get(adaId, sealed[0]?.raw_key ?? "");
      assert.equal(Buffer.from(onS3).includes(Buffer.from("forecast-bytes")), false);

      const other = await openMailbox(db, beaId, profile(beaId, beaEmail, "Bea"));
      assert.equal(other.messages.some((item) => item.subject === "Forecast"), false);
      assert.equal(await storageFor(beaId).get(sealed[0]?.raw_key ?? ""), null);

      const backup = await exportMailbox(db, storageFor(adaId), adaId);
      await openMailbox(db, copyId, profile(copyId, `copy.${suffix}@cumuluscloud.app`, "Copy"));
      const restored = await importMailbox(db, storageFor, copyId, { ...backup, tenantId: adaId });
      const again = restored.messages.find((item) => item.subject === "Forecast");
      assert.ok(again?.attachments?.[0]?.id);
      const restoredFile = await readAttachment(db, storageFor(copyId), copyId, again.id, again.attachments[0].id);
      assert.equal(new TextDecoder().decode(restoredFile?.bytes), "forecast-bytes");
      assert.equal(restored.me.email, `copy.${suffix}@cumuluscloud.app`);
    } finally {
      await client.end();
    }
  },
);
