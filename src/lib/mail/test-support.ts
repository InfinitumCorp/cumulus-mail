import { mkdtemp, rm } from "node:fs/promises";
import { readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { createFilesystemDriver, openTenantStorage, type StorageDriver } from "../storage/index.ts";
import type { TenantStorage } from "./delivery.ts";
import type { MailProfile } from "./snapshot.ts";
import type { MailQuery } from "./query.ts";

if (!process.env.MAIL_BLOB_KEY) process.env.MAIL_BLOB_KEY = "ab".repeat(32);

export async function createHarness() {
  const pg = new PGlite();
  await pg.waitReady;
  const migrationsDir = fileURLToPath(new URL("../../../migrations/", import.meta.url));
  const files = readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const name of files) {
    await pg.exec(readFileSync(join(migrationsDir, name), "utf8"));
  }
  const root = await mkdtemp(join(tmpdir(), "cumulus-mail-"));
  const driver: StorageDriver = createFilesystemDriver(root);
  const db: MailQuery = {
    query: async <T>(text: string, params: unknown[] = []) => {
      const result = await pg.query<T>(text, params);
      return result.rows;
    },
  };
  const storageFor: TenantStorage = (tenantId) => openTenantStorage(tenantId, driver);
  return {
    db,
    driver,
    root,
    storageFor,
    async close() {
      await pg.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

export function profile(tenantId: string, email: string, name = email.split("@")[0] || email): MailProfile {
  return { name, email, cid: `cid:${tenantId}`, plan: "Free", quotaGb: 15 };
}

/**
 * Make a mailbox an established, verified sender: email verified and older than the warm-up week
 * (outbound/safety.ts). For tests about SMTP, retries and caps rather than about those rules.
 */
export async function establishedSender(db: { query: (text: string, params?: unknown[]) => Promise<unknown> }, tenantId: string): Promise<void> {
  await db.query(
    `update cumulus_mail.mailboxes set send_verified = true, created_at = now() - interval '30 days' where tenant_id = $1`,
    [tenantId],
  );
}
