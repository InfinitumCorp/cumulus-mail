import { config } from "zod";

/**
 * No `new Function` in zod. Its JIT fast path starts with a `Function("")` probe, which a strict CSP
 * (src/lib/csp.ts) reports as a violation on every page even though zod catches the error and falls
 * back. Imported first in src/router.tsx, before any schema runs.
 */
config({ jitless: true });
