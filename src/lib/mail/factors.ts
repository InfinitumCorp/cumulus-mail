import { FACTOR_WINDOW_MS } from "../auth/factor-gate.ts";
import {
  generateRecoveryCodes,
  generateTotpSecret,
  matchTotpStep,
  otpauthUri,
  recoveryHash,
  recoveryMatches,
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
  /** From migration 0022. Absent (undefined) on a database that has not applied it yet. */
  satisfied_sessions?: string;
  totp_last_step?: string | number | null;
  failures?: number;
  failures_since?: string | Date | null;
};

/** Failed codes or key checks allowed per mailbox in FAILURE_WINDOW_MS, across every process. */
export const MAX_FAILURES = 10;
export const FAILURE_WINDOW_MS = 15 * 60_000;

type SessionPass = { h: string; until: string };

/** What identifies "this sign-in" for the factor: a hash of the session id (or of the bearer token). */
export async function factorSessionKey(sessionId: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(`factor:${sessionId}`).digest("hex");
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

async function readRow(db: MailQuery, tenantId: string): Promise<Row | null> {
  const rows = await db.query<Row>(
    // `select *` so the columns of migration 0022 are read when present and the code still works
    // (with the older per-mailbox window) on a database that has not applied it yet.
    `select * from cumulus_mail.second_factors where tenant_id = $1`,
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

function passesOf(row: Row | null, now = Date.now()): SessionPass[] {
  return parseJson<SessionPass[]>(row?.satisfied_sessions ?? "[]", []).filter((item) => Date.parse(item.until) > now);
}

/**
 * Whether this session has passed the factor. With migration 0022 a pass belongs to the session that
 * earned it; before it, to the whole mailbox (the original behaviour).
 */
function satisfied(row: Row | null, session: string, now = Date.now()): boolean {
  if (!row) return false;
  if (row.satisfied_sessions !== undefined) return passesOf(row, now).some((item) => item.h === session);
  if (!row.satisfied_until) return false;
  return new Date(row.satisfied_until).getTime() > now;
}

/** Record a pass for this session (or, before migration 0022, for the mailbox). */
async function markSatisfied(db: MailQuery, tenantId: string, row: Row | null, session: string): Promise<void> {
  const until = new Date(Date.now() + FACTOR_WINDOW_MS).toISOString();
  if (row?.satisfied_sessions === undefined) {
    await db.query(`update cumulus_mail.second_factors set satisfied_until = $2 where tenant_id = $1`, [tenantId, until]);
    return;
  }
  const passes = [...passesOf(row).filter((item) => item.h !== session), { h: session, until }].slice(-20);
  await db.query(
    `update cumulus_mail.second_factors set satisfied_sessions = $2, failures = 0, failures_since = null where tenant_id = $1`,
    [tenantId, JSON.stringify(passes)],
  );
}

/** Refuse while the mailbox has had too many failed checks lately (only with migration 0022). */
function assertNotThrottled(row: Row | null, now = Date.now()): void {
  if (row?.failures === undefined || !row.failures_since) return;
  const since = new Date(row.failures_since).getTime();
  if (now - since < FAILURE_WINDOW_MS && row.failures >= MAX_FAILURES) {
    throw new Error("Too many tries. Wait 15 minutes, then try again.");
  }
}

/** Count one failed check, atomically, in a window that restarts once it has passed. */
async function noteFailure(db: MailQuery, tenantId: string, row: Row | null): Promise<void> {
  if (row?.failures === undefined) return;
  await db.query(
    `update cumulus_mail.second_factors
        set failures = case when failures_since is null or failures_since < now() - make_interval(secs => $2) then 1 else failures + 1 end,
            failures_since = case when failures_since is null or failures_since < now() - make_interval(secs => $2) then now() else failures_since end
      where tenant_id = $1`,
    [tenantId, FAILURE_WINDOW_MS / 1000],
  );
}

/**
 * Change one JSON column only if it still holds what was read: a challenge or recovery code is spent
 * once even when two requests race for it. False when another request got there first.
 */
async function swapColumn(
  db: MailQuery,
  tenantId: string,
  column: "challenges" | "recovery_hashes",
  before: string,
  after: string,
): Promise<boolean> {
  const rows = await db.query(
    `update cumulus_mail.second_factors set ${column} = $3 where tenant_id = $1 and ${column} = $2 returning tenant_id`,
    [tenantId, before, after],
  );
  return rows.length > 0;
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
export async function factorStatus(db: MailQuery, tenantId: string, session: string): Promise<FactorStatus> {
  const row = await readRow(db, tenantId);
  return {
    totp: row?.totp_confirmed === true,
    pending: Boolean(row?.totp_secret) && row?.totp_confirmed !== true,
    credentials: credentialsOf(row).map((item) => ({ id: item.id, name: item.name })),
    satisfied: satisfied(row, session),
  };
}

/**
 * True when a factor is enrolled and this session has not passed it within the window. Pending
 * enrollment does not lock the mailbox.
 */
export async function factorBlocks(db: MailQuery, tenantId: string, session: string): Promise<boolean> {
  const row = await readRow(db, tenantId);
  if (!row) return false;
  const enrolled = row.totp_confirmed === true || credentialsOf(row).length > 0;
  return enrolled && !satisfied(row, session);
}

export async function beginTotp(db: MailQuery, tenantId: string, email: string): Promise<{ secret: string; otpauth: string }> {
  const row = await readRow(db, tenantId);
  if (row?.totp_confirmed) throw new Error("An authenticator is already on. Turn it off before creating another.");
  const secret = generateTotpSecret();
  await write(db, tenantId, { secret, confirmed: false });
  return { secret, otpauth: otpauthUri(email, secret) };
}

export async function confirmTotp(db: MailQuery, tenantId: string, code: string, session: string): Promise<{ recoveryCodes: string[] }> {
  const row = await readRow(db, tenantId);
  const secret = secretOf(tenantId, row);
  if (!secret || row?.totp_confirmed) throw new Error("Start authenticator setup first.");
  const step = matchTotpStep(secret, code);
  if (step < 0) throw new Error("That code is not valid.");
  const recoveryCodes = generateRecoveryCodes();
  await write(db, tenantId, { confirmed: true, hashes: recoveryCodes.map(recoveryHash) });
  if (row?.totp_last_step !== undefined) {
    await db.query(`update cumulus_mail.second_factors set totp_last_step = $2 where tenant_id = $1`, [tenantId, step]);
  }
  await markSatisfied(db, tenantId, await readRow(db, tenantId), session);
  return { recoveryCodes };
}

/**
 * Check an authenticator code or a recovery code. A code is accepted once: the TOTP step is recorded
 * (a later code must be from a newer step) and a recovery code is removed in the same update that
 * checks it is still there. Failures count against the mailbox (MAX_FAILURES per window).
 */
async function consumeCode(db: MailQuery, tenantId: string, code: string): Promise<Row | null> {
  const row = await readRow(db, tenantId);
  if (!row?.totp_confirmed) throw new Error("No authenticator is on.");
  assertNotThrottled(row);
  const secret = secretOf(tenantId, row);
  const step = matchTotpStep(secret, code);
  if (step >= 0) {
    if (row.totp_last_step === undefined) return row;
    const taken = await db.query(
      `update cumulus_mail.second_factors set totp_last_step = $2
        where tenant_id = $1 and (totp_last_step is null or totp_last_step < $2) returning tenant_id`,
      [tenantId, step],
    );
    if (taken.length) return row;
    await noteFailure(db, tenantId, row);
    throw new Error("That code was already used. Wait for the next one.");
  }
  const hashes = hashesOf(row);
  const index = recoveryMatches(hashes, code);
  if (index < 0) {
    await noteFailure(db, tenantId, row);
    throw new Error("That code is not valid.");
  }
  const remaining = hashes.filter((_, i) => i !== index);
  if (!(await swapColumn(db, tenantId, "recovery_hashes", row.recovery_hashes, JSON.stringify(remaining)))) {
    throw new Error("That recovery code was just used.");
  }
  return row;
}

export async function verifyTotp(db: MailQuery, tenantId: string, code: string, session: string): Promise<void> {
  const row = await consumeCode(db, tenantId, code);
  await markSatisfied(db, tenantId, row, session);
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
  const challenges = [...challengesOf(row), { id: challenge, kind: "register" as const, challenge, expires: Date.now() + 5 * 60_000 }].slice(-10);
  await write(db, tenantId, { challenges });
  const { createHash } = await import("node:crypto");
  return { challenge, rpId: party.rpId, userId: createHash("sha256").update(tenantId).digest("base64url"), userName };
}

/** Take one challenge out, atomically: a challenge answers one request, however many race for it. */
async function spendChallenge(db: MailQuery, tenantId: string, row: Row | null, kind: Challenge["kind"], challenge: string | undefined): Promise<Challenge> {
  const challenges = challengesOf(row);
  const match = challenges.find((item) => item.kind === kind && item.challenge === challenge);
  if (!match || !row) throw new Error(kind === "register" ? "That security-key setup expired. Start again." : "That security-key check expired. Start again.");
  const rest = challenges.filter((item) => item.challenge !== match.challenge);
  if (!(await swapColumn(db, tenantId, "challenges", row.challenges, JSON.stringify(rest)))) {
    throw new Error("That security-key request was already used. Start again.");
  }
  return match;
}

export async function finishRegistration(
  db: MailQuery,
  tenantId: string,
  origin: string,
  appHost: string,
  name: string,
  response: RegistrationResponse,
  session: string,
): Promise<{ id: string }> {
  const party = partyOrThrow(origin, appHost);
  const row = await readRow(db, tenantId);
  const parsed = JSON.parse(Buffer.from(response.clientDataJSON, "base64url").toString("utf8")) as { challenge?: string };
  const match = await spendChallenge(db, tenantId, row, "register", parsed.challenge);
  const verified = verifyRegistration(response, match.challenge, party);
  const existing = credentialsOf(row);
  if (existing.some((item) => item.id === verified.id)) throw new Error("That security key is already on this mailbox.");
  const credential: StoredCredential = {
    ...verified.credential,
    name: name.trim().slice(0, 80) || "Security key",
    createdAt: new Date().toISOString(),
  };
  await write(db, tenantId, { credentials: [...existing, credential].slice(0, 10) });
  // Registering is allowed only while this session is unlocked (or nothing was enrolled yet), so it
  // may keep this session open; it never unlocks another one.
  await markSatisfied(db, tenantId, await readRow(db, tenantId), session);
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
  assertNotThrottled(row);
  const credentials = credentialsOf(row);
  if (!credentials.length) throw new Error("No security key is on this mailbox.");
  const challenge = newChallenge();
  await write(db, tenantId, {
    challenges: [...challengesOf(row), { id: challenge, kind: "assert" as const, challenge, expires: Date.now() + 5 * 60_000 }].slice(-10),
  });
  return { challenge, rpId: party.rpId, credentialIds: credentials.map((item) => item.id) };
}

export async function finishAssertion(
  db: MailQuery,
  tenantId: string,
  origin: string,
  appHost: string,
  response: AssertionResponse,
  session: string,
): Promise<void> {
  const party = partyOrThrow(origin, appHost);
  const row = await readRow(db, tenantId);
  assertNotThrottled(row);
  const parsed = JSON.parse(Buffer.from(response.clientDataJSON, "base64url").toString("utf8")) as { challenge?: string };
  const match = await spendChallenge(db, tenantId, row, "assert", parsed.challenge);
  const credentials = credentialsOf(row);
  const credential = credentials.find((item) => item.id === response.id);
  let counter: number;
  try {
    if (!credential) throw new Error("Unknown security key");
    counter = verifyAssertion(response, match.challenge, party, credential);
  } catch (error) {
    await noteFailure(db, tenantId, row);
    throw error;
  }
  await write(db, tenantId, {
    credentials: credentials.map((item) => (item.id === credential.id ? { ...item, counter } : item)),
  });
  await markSatisfied(db, tenantId, await readRow(db, tenantId), session);
}

/** Only reachable from an unlocked session (the gate in mailbox.server.ts refuses it while locked). */
export async function removeCredential(db: MailQuery, tenantId: string, id: string): Promise<void> {
  const row = await readRow(db, tenantId);
  await write(db, tenantId, { credentials: credentialsOf(row).filter((item) => item.id !== id) });
}

/** The factor actions a locked session may use: checking in, nothing else. */
export const UNLOCK_ACTIONS = new Set(["status", "totp-verify", "webauthn-assert-options", "webauthn-assert"]);
