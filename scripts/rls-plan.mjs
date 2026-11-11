// @ts-check
/**
 * Static reading of the `cumulus_mail` schema and of the row-level-security
 * file that is meant to cover it.
 *
 * The point is that the two cannot drift: a new table in `migrations/*.sql`
 * without a policy in `migrations/rls/*.sql` is a table that is readable by any
 * connection that reaches the database, which is exactly what the RLS file is
 * there to prevent. `scripts/rls-plan.test.mjs` asserts the two sets match.
 */

const CREATE_TABLE =
  /create\s+table\s+(?:if\s+not\s+exists\s+)?cumulus_mail\.([a-z_][a-z0-9_]*)/gi;
const ENABLE_RLS =
  /alter\s+table\s+cumulus_mail\.([a-z_][a-z0-9_]*)\s+enable\s+row\s+level\s+security/gi;
const CREATE_POLICY =
  /create\s+policy\s+[a-z_][a-z0-9_]*\s+on\s+cumulus_mail\.([a-z_][a-z0-9_]*)/gi;

/**
 * @param {RegExp} pattern
 * @param {string} sql
 * @returns {Set<string>}
 */
function names(pattern, sql) {
  const found = new Set();
  // A fresh lastIndex per call keeps the module-level /g patterns reusable.
  pattern.lastIndex = 0;
  for (const match of sql.matchAll(pattern)) found.add(match[1].toLowerCase());
  return found;
}

/**
 * Tables the schema creates.
 * @param {string} sql All of `migrations/*.sql`, concatenated.
 * @returns {Set<string>}
 */
export function schemaTables(sql) {
  return names(CREATE_TABLE, sql);
}

/**
 * Tables the RLS file turns row level security on for, and tables it writes a
 * policy for. Enabling without a policy denies everything; a policy without
 * enabling is never consulted. Both sets have to be the full schema.
 * @param {string} sql All of `migrations/rls/*.sql`, concatenated.
 * @returns {{ enabled: Set<string>, policies: Set<string> }}
 */
export function rlsCoverage(sql) {
  return { enabled: names(ENABLE_RLS, sql), policies: names(CREATE_POLICY, sql) };
}

/**
 * Members of `expected` that `actual` is missing, sorted.
 * @param {Set<string>} expected
 * @param {Set<string>} actual
 * @returns {string[]}
 */
export function missingFrom(expected, actual) {
  return [...expected].filter((name) => !actual.has(name)).sort();
}
