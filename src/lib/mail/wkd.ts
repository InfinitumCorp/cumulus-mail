import { mailAppHost, mailDomain } from "./domain.ts";
import { openText } from "./field-crypto.ts";
import { publicKeyBinary, splitAddress, wkdLocalHash } from "./pgp-keys.ts";
import type { MailQuery } from "./query.ts";

/**
 * Publish or remove this mailbox's OpenPGP key for WKD.
 * The public key is public. Addresses that do not parse are skipped.
 */
export async function publishMailboxKey(
  db: MailQuery,
  tenantId: string,
  addresses: string[],
  publicKey: string | null,
): Promise<void> {
  await db.query(`delete from cumulus_mail.wkd_keys where tenant_id = $1`, [tenantId]);
  if (!publicKey) return;
  const seen = new Set<string>();
  for (const address of addresses) {
    const parts = splitAddress(address);
    if (!parts) continue;
    const hash = await wkdLocalHash(parts.local);
    const id = `${parts.domain}\0${hash}`;
    if (seen.has(id)) continue;
    seen.add(id);
    await db.query(
      `insert into cumulus_mail.wkd_keys (tenant_id, domain, local_hash, public_key) values ($1, $2, $3, $4)
       on conflict (domain, local_hash) do update set tenant_id = excluded.tenant_id, public_key = excluded.public_key`,
      [tenantId, parts.domain, hash, publicKey.slice(0, 20_000)],
    );
  }
}

async function armoredFor(db: MailQuery, where: string, params: unknown[]): Promise<string | null> {
  const rows = await db.query<{ public_key: string }>(
    `select public_key from cumulus_mail.wkd_keys where ${where}`,
    params,
  );
  return rows[0]?.public_key ?? null;
}

/** Binary key for the advanced WKD path, which includes the domain. */
export async function wkdAdvancedKey(db: MailQuery, domain: string, hash: string): Promise<Uint8Array | null> {
  const armored = await armoredFor(db, `domain = $1 and local_hash = $2`, [domain, hash]);
  return armored ? publicKeyBinary(armored) : null;
}

/**
 * Binary key for the direct path. The path has only the local part's hash; the domain is the host the
 * request came to (RFC 7929 §3.1: https://<domain>/.well-known/openpgpkey/hu/<hash>). Matching the
 * hash alone served bob@custom.example's key for bob@<any domain pointed here>.
 */
export async function wkdDirectKey(db: MailQuery, hash: string, domain: string): Promise<Uint8Array | null> {
  if (!domain) return null;
  return wkdAdvancedKey(db, domain, hash);
}

/** The mail domain a direct WKD request is for: its host, or the platform domain on the app host. */
export function directDomain(host: string): string {
  const name = host.toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
  return name === mailAppHost().toLowerCase() ? mailDomain().toLowerCase() : name;
}

export async function mailboxAddresses(db: MailQuery, tenantId: string, primary: string): Promise<string[]> {
  const rows = await db.query<{ address: string }>(`select address from cumulus_mail.aliases where tenant_id = $1`, [tenantId]);
  return [primary, ...rows.map((row) => openText(tenantId, row.address))];
}

const HASH = /^[a-z0-9]{32}$/;
const DOMAIN = /^[a-z0-9.-]+\.[a-z]{2,}$/;

/** HTTP body for a WKD path, or null when the path is not WKD. A miss is a 404 response. */
export async function wkdResponse(db: MailQuery, path: string, host = ""): Promise<Response | null> {
  if (path === "/.well-known/openpgpkey/policy") {
    return new Response("", { status: 200, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=3600" } });
  }
  const advanced = /^\/\.well-known\/openpgpkey\/([a-z0-9.-]+)\/hu\/([a-z0-9]+)$/.exec(path);
  const direct = /^\/\.well-known\/openpgpkey\/hu\/([a-z0-9]+)$/.exec(path);
  if (!advanced && !direct) return null;
  const hash = (advanced?.[2] ?? direct?.[1] ?? "").toLowerCase();
  const domain = advanced?.[1]?.toLowerCase() ?? "";
  if (!HASH.test(hash) || (advanced && !DOMAIN.test(domain))) {
    return new Response("Not found", { status: 404 });
  }
  const bytes = advanced ? await wkdAdvancedKey(db, domain, hash) : await wkdDirectKey(db, hash, directDomain(host));
  if (!bytes) return new Response("Not found", { status: 404 });
  return new Response(Buffer.from(bytes), {
    status: 200,
    headers: { "content-type": "application/octet-stream", "cache-control": "public, max-age=3600" },
  });
}
