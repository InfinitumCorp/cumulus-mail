import test from "node:test";
import assert from "node:assert/strict";
import { findServerCode, SERVER_MARKERS } from "./client-bundle-guard.mjs";

test("the browser auth client passes, including its env getter that names BETTER_AUTH_SECRET", () => {
  const client =
    "var M=Symbol.for(`better-auth:auth-query`);Object.freeze({get BETTER_AUTH_SECRET(){return o(`BETTER_AUTH_SECRET`)}})";
  assert.deepEqual(findServerCode({ "client-x.js": client }), []);
});

test("server modules and secret names are caught, with the file named", () => {
  const hits = findServerCode({
    "a.js": "import{kyselyAdapter}from'better-auth/adapters/kysely';",
    "b.js": "const k=process.env.MAIL_BLOB_KEY;",
    "c.css": "body{}",
  });
  assert.deepEqual(hits, [
    { file: "a.js", marker: "kyselyAdapter" },
    { file: "a.js", marker: "better-auth/adapters" },
    { file: "b.js", marker: "MAIL_BLOB_KEY" },
  ]);
});

test("openpgp's own crypto is not mistaken for server code", () => {
  assert.deepEqual(findServerCode({ "openpgp.min.js": "e.createCipheriv(n,t,r)" }), []);
  assert.ok(!SERVER_MARKERS.includes("createCipheriv"));
});
