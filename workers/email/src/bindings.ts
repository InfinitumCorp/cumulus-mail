import { assertPgConnectionString } from "../../../src/lib/pg-connection.ts";
import {
  createS3Driver,
  type S3DriverOptions,
  type StorageDriver,
} from "../../../src/lib/storage/driver.ts";
import { openTenantStorage } from "../../../src/lib/storage/index.ts";
import type { TenantStorage } from "../../../src/lib/mail/delivery.ts";
import type { MailQuery } from "../../../src/lib/mail/query.ts";
import type { InboundDeps } from "./index.ts";

export type QueryClient = {
  query: (text: string, params?: unknown[]) => Promise<unknown[]>;
  end: () => Promise<void>;
};

export type IngestHooks = {
  connect: (connectionString: string) => Promise<QueryClient>;
  createDriver: (options: S3DriverOptions) => StorageDriver;
};

export type WorkerBindings = {
  HYPERDRIVE?: { connectionString?: string };
  MAIL_BLOB_KEY?: string;
  /** Key ring for rotation (docs/ops/key-rotation.md): current key first, old keys after. */
  MAIL_BLOB_KEYS?: string;
  /** Stable key for blind indexes; defaults to MAIL_BLOB_KEY. */
  MAIL_BLIND_KEY?: string;
  CUMULUS_ALLOW_SUPABASE?: string;
  MAIL_S3_LOOPBACK_ONLY?: string;
  SUPABASE_S3_ENDPOINT?: string;
  SUPABASE_S3_REGION?: string;
  SUPABASE_S3_ACCESS_KEY_ID?: string;
  SUPABASE_S3_SECRET_ACCESS_KEY?: string;
  SUPABASE_S3_BUCKET?: string;
  MAIL_S3_ENDPOINT?: string;
  MAIL_S3_REGION?: string;
  MAIL_S3_ACCESS_KEY_ID?: string;
  MAIL_S3_SECRET_ACCESS_KEY?: string;
  MAIL_S3_BUCKET?: string;
  ingestHooks?: Partial<IngestHooks>;
};

export type OpenedIngest = InboundDeps & { close: () => Promise<void> };

const NOT_DEPLOYED =
  "Cumulus mail inbound ingest is not configured. This worker template is not deployed.";

function first(
  env: WorkerBindings,
  primary: keyof WorkerBindings,
  fallback: keyof WorkerBindings,
): string {
  const preferred = env[primary];
  const alternate = env[fallback];
  if (typeof preferred === "string" && preferred.trim()) return preferred.trim();
  if (typeof alternate === "string" && alternate.trim()) return alternate.trim();
  return "";
}

async function connectPg(connectionString: string): Promise<QueryClient> {
  const { Client } = await import("pg");
  const client = new Client({ connectionString });
  await client.connect();
  return {
    query: async (text, params) => {
      const result = await client.query(text, params ?? []);
      return result.rows as unknown[];
    },
    end: () => client.end(),
  };
}

/**
 * Build the ingest object from a Hyperdrive binding and Supabase Storage S3
 * settings. The connection string is passed to `pg` unchanged. Blob bytes use
 * the existing per-tenant AES-256-GCM (`MAIL_BLOB_KEYS`, else `MAIL_BLOB_KEY`) and
 * `tenants/<tenantId>/<blobId>` keys.
 */
export async function openWorkerIngest(
  env: WorkerBindings,
  hooks: Partial<IngestHooks> = env.ingestHooks ?? {},
): Promise<OpenedIngest> {
  const raw = env.HYPERDRIVE?.connectionString?.trim() ?? "";
  if (!raw) throw new Error(NOT_DEPLOYED);
  const connectionString = assertPgConnectionString(raw);

  const endpoint = first(env, "SUPABASE_S3_ENDPOINT", "MAIL_S3_ENDPOINT");
  const accessKeyId = first(env, "SUPABASE_S3_ACCESS_KEY_ID", "MAIL_S3_ACCESS_KEY_ID");
  const secretAccessKey = first(env, "SUPABASE_S3_SECRET_ACCESS_KEY", "MAIL_S3_SECRET_ACCESS_KEY");
  const bucket = first(env, "SUPABASE_S3_BUCKET", "MAIL_S3_BUCKET") || "cumulus-mail";
  const region = first(env, "SUPABASE_S3_REGION", "MAIL_S3_REGION") || "us-east-1";
  if (!endpoint || !accessKeyId || !secretAccessKey) {
    throw new Error("Supabase Storage is not configured for the inbound worker.");
  }
  for (const name of ["MAIL_BLOB_KEY", "MAIL_BLOB_KEYS", "MAIL_BLIND_KEY"] as const) {
    const value = env[name]?.trim();
    if (value) process.env[name] = value;
  }
  if (env.CUMULUS_ALLOW_SUPABASE?.trim()) {
    process.env.CUMULUS_ALLOW_SUPABASE = env.CUMULUS_ALLOW_SUPABASE.trim();
  }
  const { masterKeyFromEnv } = await import("../../../src/lib/storage/crypto.ts");
  masterKeyFromEnv();

  const connect = hooks.connect ?? connectPg;
  const createDriver = hooks.createDriver ?? createS3Driver;
  const options: S3DriverOptions = {
    endpoint,
    region,
    bucket,
    accessKeyId,
    secretAccessKey,
    loopbackOnly: env.MAIL_S3_LOOPBACK_ONLY === "1",
  };
  const client = await connect(connectionString);
  try {
    const driver = createDriver(options);
    const db: MailQuery = {
      query: <T>(text: string, params?: unknown[]) => client.query(text, params) as Promise<T[]>,
    };
    const storageFor: TenantStorage = (tenantId) => openTenantStorage(tenantId, driver);
    return {
      db,
      storageFor,
      close: () => client.end(),
    };
  } catch (error) {
    await client.end();
    throw error;
  }
}
