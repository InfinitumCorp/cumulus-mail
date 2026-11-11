/**
 * Which settings inbound mail needs, decided from an environment alone.
 *
 * Separate from `ingest.server.ts` so it can be read and tested without pulling
 * in the database module, the storage drivers, or the AWS SDK.
 */
export type IngestEnv = {
  MAIL_STORAGE?: string;
  MAIL_S3_BUCKET?: string;
  MAIL_S3_ENDPOINT?: string;
  MAIL_S3_ACCESS_KEY_ID?: string;
  MAIL_S3_SECRET_ACCESS_KEY?: string;
  MAIL_BLOB_KEY?: string;
  CUMULUS_ALLOW_SUPABASE?: string;
  [key: string]: string | undefined;
};

function set(value: string | undefined): boolean {
  return Boolean(value && value.trim());
}

/**
 * Settings that inbound mail cannot run without, by name, in the order an
 * operator would fill them in. Empty means the mailbox can accept a message.
 *
 * `hasDatabase` is passed in rather than read here, because on Workers the
 * connection string can come from a Hyperdrive binding instead of a variable.
 *
 * Local disk is a valid store under Node (`MAIL_STORAGE` unset, the default),
 * but workerd has no filesystem, so on Workers the S3 driver is required. That
 * driver is what Supabase Storage speaks.
 */
export function missingIngestSettings(
  env: IngestEnv,
  options: { hasDatabase: boolean; workers?: boolean },
): string[] {
  const missing: string[] = [];
  if (!options.hasDatabase) {
    missing.push(options.workers ? "DATABASE_URL (or a Hyperdrive binding named MAIL_DB)" : "DATABASE_URL");
  }
  if (!set(env.MAIL_BLOB_KEY)) missing.push("MAIL_BLOB_KEY");
  const storage = (env.MAIL_STORAGE ?? "").trim().toLowerCase();
  if (storage !== "s3") {
    if (options.workers) missing.push("MAIL_STORAGE=s3 (Workers have no local disk)");
    return missing;
  }
  if (!set(env.MAIL_S3_BUCKET)) missing.push("MAIL_S3_BUCKET");
  if (!set(env.MAIL_S3_ENDPOINT)) missing.push("MAIL_S3_ENDPOINT");
  if (!set(env.MAIL_S3_ACCESS_KEY_ID)) missing.push("MAIL_S3_ACCESS_KEY_ID");
  if (!set(env.MAIL_S3_SECRET_ACCESS_KEY)) missing.push("MAIL_S3_SECRET_ACCESS_KEY");
  // The S3 driver itself refuses a *.supabase.co host without this flag. Name it
  // here so the reason is in the message instead of inside the driver's throw.
  if (/\.supabase\.co(\/|$)/i.test(env.MAIL_S3_ENDPOINT ?? "") && env.CUMULUS_ALLOW_SUPABASE !== "1") {
    missing.push("CUMULUS_ALLOW_SUPABASE=1");
  }
  return missing;
}
