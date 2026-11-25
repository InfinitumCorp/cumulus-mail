import { FACTOR_WINDOW_MS } from "../auth/factor-gate.ts";
import {
  generateRecoveryCodes,
  generateTotpSecret,
  otpauthUri,
  recoveryHash,
  recoveryMatches,
  verifyTotpCode,
} from "../auth/totp.ts";
import {
  newChallenge,
  relyingParty,
  verifyAssertion,
  verifyRegistration,
  type AssertionResponse,
  type RegistrationResponse,
  type RelyingParty,
  type StoredCredential,
} from "../auth/webauthn.ts";
import { openText, sealText } from "./field-crypto.ts";
import type { MailQuery } from "./query.ts";

type Challenge = { id: string; kind: "register" | "assert"; challenge: string; expires: number };

type Row = {
  totp_secret: string | null;
  totp_confirmed: boolean;
  recovery_hashes: string;
  credentials: string;
  challenges: string;
  satisfied_until: string | Date | null;
};

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

async function readRow(db: MailQuery, tenantId: string): Promise<Row | null> {
  const rows = await db.query<Row>(
    `select totp_secret, totp_confirmed, recovery_hashes, credentials, challenges, satisfied_until
     from cumulus_mail.second_factors where tenant_id = $1`,
    [tenantId],
  );
  return rows[0] ?? null;
}

async function ensure(db: MailQuery, tenantId: string): Promise<void> {
  await db.query(`insert into cumulus_mail.second_factors (tenant_id) values ($1) on conflict do nothing`, [tenantId]);
}

function secretOf(tenantId: string, row: Row | null): string {
  if (!row?.totp_secret) return "";
  return openText(tenantId, row.totp_secret);
}

function credentialsOf(row: Row | null): StoredCredential[] {
  return parseJson<StoredCredential[]>(row?.credentials ?? "[]", []);
}

function hashesOf(row: Row | null): string[] {
  return parseJson<string[]>(row?.recovery_hashes ?? "[]", []);
}

function challengesOf(row: Row | null): Challenge[] {
  const now = Date.now();
  return parseJson<Challenge[]>(row?.challenges ?? "[]", []).filter((item) => item.expires > now);
}

function satisfied(row: Row | null, now = Date.now()): boolean {
  if (!row?.satisfied_until) return false;
  return new Date(row.satisfied_until).getTime() > now;
}

async function write(
  db: MailQuery,
  tenantId: string,
  patch: {
    secret?: string | null;
    confirmed?: boolean;
    hashes?: string[];
    credentials?: StoredCredential[];
    challenges?: Challenge[];
    satisfy?: boolean;
  },
): Promise<void> {
  await ensure(db, tenantId);
  const sets: string[] = [];
  const params: unknown[] = [tenantId];
  const add = (column: string, value: unknown) => {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  };
  if (patch.secret !== undefined) add("totp_secret", patch.secret ? sealText(tenantId, patch.secret) : null);
  if (patch.confirmed !== undefined) add("totp_confirmed", patch.confirmed);
  if (patch.hashes) add("recovery_hashes", JSON.stringify(patch.hashes));
  if (patch.credentials) add("credentials", JSON.stringify(patch.credentials));
  if (patch.challenges) add("challenges", JSON.stringify(patch.challenges));
  if (patch.satisfy) add("satisfied_until", new Date(Date.now() + FACTOR_WINDOW_MS).toISOString());
  if (!sets.length) return;
  await db.query(`update cumulus_mail.second_factors set ${sets.join(", ")} where tenant_id = $1`, params);
}

export type FactorStatus = {
  totp: boolean;
  pending: boolean;
  credentials: Array<{ id: string; name: string }>;
  satisfied: boolean;
};

/** No secrets. */
export async function factorStatus(db: MailQuery, tenantId: string): Promise<FactorStatus> {
  const row = await readRow(db, tenantId);
  return {
    totp: row?.totp_confirmed === true,
    pending: Boolean(row?.totp_secret) && row?.totp_confirmed !== true,
    credentials: credentialsOf(row).map((item) => ({ id: item.id, name: item.name })),
    satisfied: satisfied(row),
  };
}

/** True when a factor is enrolled and the window has lapsed. Pending enrollment does not lock the mailbox. */
export async function factorBlocks(db: MailQuery, tenantId: string): Promise<boolean> {
  const row = await readRow(db, tenantId);
  if (!row) return false;
  const enrolled = row.totp_confirmed === true || credentialsOf(row).length > 0;
  return enrolled && !satisfied(row);
}

export async function beginTotp(db: MailQuery, tenantId: string, email: string): Promise<{ secret: string; otpauth: string }> {
  const row = await readRow(db, tenantId);
  if (row?.totp_confirmed) throw new Error("An authenticator is already on. Turn it off before creating another.");
  const secret = generateTotpSecret();
  await write(db, tenantId, { secret, confirmed: false });
  return { secret, otpauth: otpauthUri(email, secret) };
}

export async function confirmTotp(db: MailQuery, tenantId: string, code: string): Promise<{ recoveryCodes: string[] }> {
  const row = await readRow(db, tenantId);
  const secret = secretOf(tenantId, row);
  if (!secret || row?.totp_confirmed) throw new Error("Start authenticator setup first.");
  if (!verifyTotpCode(secret, code)) throw new Error("That code is not valid.");
  const recoveryCodes = generateRecoveryCodes();
  await write(db, tenantId, { confirmed: true, hashes: recoveryCodes.map(recoveryHash), satisfy: true });
  return { recoveryCodes };
}

async function consumeCode(db: MailQuery, tenantId: string, code: string): Promise<void> {
  const row = await readRow(db, tenantId);
  if (!row?.totp_confirmed) throw new Error("No authenticator is on.");
  const secret = secretOf(tenantId, row);
  if (verifyTotpCode(secret, code)) {
    await write(db, tenantId, { satisfy: true });
    return;
  }
  const hashes = hashesOf(row);
  const index = recoveryMatches(hashes, code);
  if (index < 0) throw new Error("That code is not valid.");
  hashes.splice(index, 1);
  await write(db, tenantId, { hashes, satisfy: true });
}

export async function verifyTotp(db: MailQuery, tenantId: string, code: string): Promise<void> {
  await consumeCode(db, tenantId, code);
}

export async function disableTotp(db: MailQuery, tenantId: string, code: string): Promise<void> {
  await consumeCode(db, tenantId, code);
  await write(db, tenantId, { secret: null, confirmed: false, hashes: [] });
}

function partyOrThrow(origin: string, appHost: string): RelyingParty {
  const party = relyingParty(origin, appHost);
  if (!party) throw new Error("This origin cannot register a security key.");
  return party;
}

export async function beginRegistration(
  db: MailQuery,
  tenantId: string,
  origin: string,
  appHost: string,
  userName: string,
): Promise<{ challenge: string; rpId: string; userId: string; userName: string }> {
  const party = partyOrThrow(origin, appHost);
  const row = await readRow(db, tenantId);
  const challenge = newChallenge();
  const challenges = [...challengesOf(row), { id: challenge, kind: "register" as const, challenge, expires: Date.now() + 5 * 60_000 }];
  await write(db, tenantId, { challenges });
  const { createHash } = await import("node:crypto");
  return { challenge, rpId: party.rpId, userId: createHash("sha256").update(tenantId).digest("base64url"), userName };
}

export async function finishRegistration(
  db: MailQuery,
  tenantId: string,
  origin: string,
  appHost: string,
  name: string,
  response: RegistrationResponse,
): Promise<{ id: string }> {
  const party = partyOrThrow(origin, appHost);
  const row = await readRow(db, tenantId);
  const challenges = challengesOf(row);
  const parsed = JSON.parse(Buffer.from(response.clientDataJSON, "base64url").toString("utf8")) as { challenge?: string };
  const match = challenges.find((item) => item.kind === "register" && item.challenge === parsed.challenge);
  if (!match) throw new Error("That security-key setup expired. Start again.");
  const verified = verifyRegistration(response, match.challenge, party);
  const existing = credentialsOf(row);
  if (existing.some((item) => item.id === verified.id)) throw new Error("That security key is already on this mailbox.");
  const credential: StoredCredential = {
    ...verified.credential,
    name: name.trim().slice(0, 80) || "Security key",
    createdAt: new Date().toISOString(),
  };
  await write(db, tenantId, {
    credentials: [...existing, credential].slice(0, 10),
    challenges: challenges.filter((item) => item.challenge !== match.challenge),
    satisfy: true,
  });
  return { id: credential.id };
}

export async function beginAssertion(
  db: MailQuery,
  tenantId: string,
  origin: string,
  appHost: string,
): Promise<{ challenge: string; rpId: string; credentialIds: string[] }> {
  const party = partyOrThrow(origin, appHost);
  const row = await readRow(db, tenantId);
  const credentials = credentialsOf(row);
  if (!credentials.length) throw new Error("No security key is on this mailbox.");
  const challenge = newChallenge();
  await write(db, tenantId, {
    challenges: [...challengesOf(row), { id: challenge, kind: "assert", challenge, expires: Date.now() + 5 * 60_000 }],
  });
  return { challenge, rpId: party.rpId, credentialIds: credentials.map((item) => item.id) };
}

export async function finishAssertion(
  db: MailQuery,
  tenantId: string,
  origin: string,
  appHost: string,
  response: AssertionResponse,
): Promise<void> {
  const party = partyOrThrow(origin, appHost);
  const row = await readRow(db, tenantId);
  const challenges = challengesOf(row);
  const parsed = JSON.parse(Buffer.from(response.clientDataJSON, "base64url").toString("utf8")) as { challenge?: string };
  const match = challenges.find((item) => item.kind === "assert" && item.challenge === parsed.challenge);
  if (!match) throw new Error("That security-key check expired. Start again.");
  const credentials = credentialsOf(row);
  const credential = credentials.find((item) => item.id === response.id);
  if (!credential) throw new Error("Unknown security key");
  const counter = verifyAssertion(response, match.challenge, party, credential);
  await write(db, tenantId, {
    credentials: credentials.map((item) => (item.id === credential.id ? { ...item, counter } : item)),
    challenges: challenges.filter((item) => item.challenge !== match.challenge),
    satisfy: true,
  });
}

export async function removeCredential(db: MailQuery, tenantId: string, id: string): Promise<void> {
  const row = await readRow(db, tenantId);
  await write(db, tenantId, { credentials: credentialsOf(row).filter((item) => item.id !== id) });
}
