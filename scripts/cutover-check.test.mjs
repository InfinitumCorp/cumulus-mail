import assert from "node:assert/strict";
import { test } from "node:test";
import { checkAnon, checkIssuer, checkMigrations } from "./cutover-check.mjs";

const levels = (findings) => findings.map((f) => f.level);

test("migrations: up to date, a clean tail to apply in order, or a hole in the middle", () => {
  const files = ["0001_a.sql", "0002_b.sql", "0003_c.sql", "0004_d.sql"];
  assert.deepEqual(levels(checkMigrations(files, files)), ["ok"]);

  const tail = checkMigrations(files, ["0001_a.sql", "0002_b.sql"]);
  assert.deepEqual(levels(tail), ["warn"]);
  assert.match(tail[0].what, /2 migration\(s\) to apply, in this order: 0003_c.sql, 0004_d.sql/);

  // Production today: 0002–0010 applied, 0001_auth.sql copied up later. Pending, not a hole.
  const prod = checkMigrations(["0001_auth.sql", "0002_b.sql", "0010_j.sql", "0011_k.sql"], ["0002_b.sql", "0010_j.sql"]);
  assert.deepEqual(levels(prod), ["warn"]);
  assert.match(prod[0].what, /in this order: 0001_auth.sql, 0011_k.sql/);

  const hole = checkMigrations(files, ["0001_a.sql", "0003_c.sql"]);
  assert.deepEqual(levels(hole), ["missing", "warn"]);
  assert.match(hole[0].what, /skipped in the middle: 0002_b.sql/);
});

function fakeDb({ anonRole = true, selectError = null, setRoleError = null }) {
  const seen = [];
  const query = async (sql) => {
    seen.push(sql);
    if (sql.includes("pg_roles")) return { rows: [{ n: anonRole ? 1 : 0 }] };
    if (sql === "set local role anon" && setRoleError) throw Object.assign(new Error("x"), { code: setRoleError });
    if (sql.includes("public.session") && selectError) throw Object.assign(new Error("x"), { code: selectError });
    return { rows: [{ count: 3 }] };
  };
  return { query, seen };
}

test("anon on public.session: refused is ok, readable blocks the cutover, and nothing is written", async () => {
  const refused = fakeDb({ selectError: "42501" });
  assert.deepEqual(levels(await checkAnon(refused.query)), ["ok"]);
  assert.ok(refused.seen.includes("set local role anon"));

  const open = fakeDb({});
  const found = await checkAnon(open.query);
  assert.deepEqual(levels(found), ["missing"]);
  assert.match(found[0].fix, /0020_auth_lockdown/);

  assert.deepEqual(levels(await checkAnon(fakeDb({ anonRole: false }).query)), ["ok"]);
  assert.deepEqual(levels(await checkAnon(fakeDb({ selectError: "42P01" }).query)), ["warn"]);
  assert.deepEqual(levels(await checkAnon(fakeDb({ selectError: "08006" }).query)), ["warn"]);
  // A login that may not become anon gets the same 42501: that must not read as "anon is refused".
  const cannotSwitch = await checkAnon(fakeDb({ setRoleError: "42501" }).query);
  assert.deepEqual(levels(cannotSwitch), ["warn"]);
  assert.match(cannotSwitch[0].what, /cannot switch to the anon role/);

  for (const sql of [...refused.seen, ...open.seen]) assert.doesNotMatch(sql, /\b(insert|update|delete|create|drop|alter|grant|revoke)\b/i, sql);
});

test("issuer: must answer 200 with JSON naming itself; each failure says which", async () => {
  const issuer = "https://id.example/realms/cumulus";
  const env = { CUMULUS_OIDC_ISSUER: `${issuer}/` };
  const answer = (status, body) => async (url) => {
    assert.equal(url, `${issuer}/.well-known/openid-configuration`);
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  };
  assert.deepEqual(levels(await checkIssuer(answer(200, { issuer }), env)), ["ok"]);
  assert.match((await checkIssuer(answer(404, {}), env))[0].what, /answers 404/);
  assert.match((await checkIssuer(answer(200, "<html>"), env))[0].what, /not JSON/);
  assert.match((await checkIssuer(answer(200, { issuer: "https://other.example" }), env))[0].what, /different issuer/);
  const down = async () => {
    throw new TypeError("fetch failed");
  };
  assert.match((await checkIssuer(down, env))[0].what, /does not answer/);
});
