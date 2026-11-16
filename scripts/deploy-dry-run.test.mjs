import assert from "node:assert/strict";
import { test } from "node:test";
import { missingModules } from "./deploy-dry-run.mjs";

test("missingModules flags every built module the upload left out, and nothing else", () => {
  const built = ["index.mjs", "_libs/h3.mjs", "_chunks/a.mjs", "_ssr/x.js", "wrangler.json", "README.md"];
  assert.deepEqual(missingModules(built, ["index.mjs", "README.md"]), ["_libs/h3.mjs", "_chunks/a.mjs", "_ssr/x.js"]);
  assert.deepEqual(missingModules(built, ["index.mjs", "_libs/h3.mjs", "_chunks/a.mjs", "_ssr/x.js"]), []);
});
