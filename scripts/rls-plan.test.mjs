import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { migrationName, pendingMigrations } from "./migration-plan.mjs";
import { missingFrom, rlsCoverage, schemaTables } from "./rls-plan.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const migrationsDir = join(root, "migrations");
const rlsDir = join(migrationsDir, "rls");

const sqlIn = (dir) =>
  readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => ({ name, sql: readFileSync(join(dir, name), "utf8") }));

const schemaSql = sqlIn(migrationsDir)
  .map((file) => file.sql)
  .join("\n");
const rlsFiles = sqlIn(rlsDir);
const rlsSql = rlsFiles.map((file) => file.sql).join("\n");

test("the schema has the tables the mailbox is built on", () => {
  const tables = schemaTables(schemaSql);
  for (const name of ["mailboxes", "messages", "attachments", "deliveries", "address_routes"]) {
    assert.ok(tables.has(name), `migrations/ should create cumulus_mail.${name}`);
  }
  assert.ok(tables.size >= 15, `expected the full mailbox schema, found ${tables.size} tables`);
});

test("every cumulus_mail table has row level security enabled and an owner policy", () => {
  const tables = schemaTables(schemaSql);
  const { enabled, policies } = rlsCoverage(rlsSql);
  assert.deepEqual(missingFrom(tables, enabled), [], "tables with no `enable row level security`");
  assert.deepEqual(missingFrom(tables, policies), [], "tables with no policy");
  // And nothing in the RLS file names a table the schema does not create.
  assert.deepEqual(missingFrom(enabled, tables), [], "policies for tables that do not exist");
});

test("the RLS file is not applied by either migrator", () => {
  assert.ok(rlsFiles.length > 0, "migrations/rls/ should hold the RLS migration");
  const applied = pendingMigrations(readdirSync(migrationsDir), []).map((entry) => entry.name);
  for (const file of rlsFiles) {
    assert.equal(
      applied.includes(migrationName(file.name)),
      false,
      `${file.name} must stay out of the applied set until an operator copies it up`,
    );
  }
  // The PGLite applier globs the same non-recursive shape.
  const globbed = pendingMigrations(
    readdirSync(migrationsDir).map((name) => `/migrations/${name}`),
    [],
  ).map((entry) => entry.name);
  assert.deepEqual(globbed, applied);
});

test("the owner scope is the column that partitions each table", () => {
  // deliveries keys by the sender, every other table by tenant_id. A policy that
  // used the wrong column would still parse, so check the pairing here.
  assert.match(rlsSql, /create policy deliveries_owner[\s\S]*?sender_tenant = cumulus_mail\.current_tenant\(\)/);
  assert.match(rlsSql, /create policy messages_owner[\s\S]*?tenant_id = cumulus_mail\.current_tenant\(\)/);
  // Every policy covers writes too, so a row cannot be written into another
  // tenant's partition.
  const policies = rlsSql.match(/create policy [\s\S]*?;/g) ?? [];
  assert.ok(policies.length >= 15);
  for (const policy of policies) {
    assert.match(policy, /for all/);
    assert.match(policy, /with check/);
  }
  // Forcing RLS would also apply it to the owning role, which the app connects
  // as without setting the tenant. That would refuse every query. The file
  // explains that in a comment, so check the statements, not the prose.
  const statements = rlsSql.replace(/--[^\n]*/g, "");
  assert.equal(/force\s+row\s+level\s+security/i.test(statements), false);
});

test("the RLS file runs on Postgres", async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const pg = new PGlite();
  await pg.waitReady;
  try {
    for (const file of sqlIn(migrationsDir)) await pg.exec(file.sql);
    for (const file of rlsFiles) await pg.exec(file.sql);

    const tables = [...schemaTables(schemaSql)].sort();
    const secured = await pg.query(
      `select c.relname as name
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'cumulus_mail' and c.relkind = 'r' and c.relrowsecurity
        order by c.relname`,
    );
    assert.deepEqual(
      secured.rows.map((row) => row.name),
      tables,
    );

    const withPolicy = await pg.query(
      `select tablename, count(*)::int as policies
         from pg_policies
        where schemaname = 'cumulus_mail'
        group by tablename
        order by tablename`,
    );
    assert.deepEqual(
      withPolicy.rows.map((row) => row.tablename),
      tables,
    );
    for (const row of withPolicy.rows) assert.equal(row.policies, 1);

    // The owner function answers from the session setting, and null when unset.
    const unset = await pg.query("select cumulus_mail.current_tenant() as tenant");
    assert.equal(unset.rows[0].tenant, null);
    await pg.exec("set cumulus_mail.tenant_id = 'tenant-ada'");
    const set = await pg.query("select cumulus_mail.current_tenant() as tenant");
    assert.equal(set.rows[0].tenant, "tenant-ada");
    // And from the PostgREST claim when the setting is absent.
    await pg.exec("reset cumulus_mail.tenant_id");
    await pg.exec(`set request.jwt.claims = '{"sub":"cognito-sub","email":"ada@cumuluscloud.app"}'`);
    const fromClaim = await pg.query("select cumulus_mail.current_tenant() as tenant");
    assert.equal(fromClaim.rows[0].tenant, "cognito-sub");
    await pg.exec(`set request.jwt.claims = '{"tenant_id":"tenant-bea","sub":"cognito-sub"}'`);
    const claimed = await pg.query("select cumulus_mail.current_tenant() as tenant");
    assert.equal(claimed.rows[0].tenant, "tenant-bea");

    // Re-running the file is a no-op, the way the migrator would retry it.
    for (const file of rlsFiles) await pg.exec(file.sql);
  } finally {
    await pg.close();
  }
});
