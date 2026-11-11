/**
 * Bundle the inbound email worker into one ESM file plus the Cloudflare
 * script-upload metadata. This does not deploy and does not set secrets.
 *
 * Output:
 *   dist/inbound/index.js       main module (ESM)
 *   dist/inbound/metadata.json  multipart `metadata` for the Workers API
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rolldown } from "rolldown";
import { projectRoot, readWorkerConfig } from "./nitro-preset.mjs";

export const INBOUND_MAIN_MODULE = "index.js";
export const INBOUND_OUT_DIR = "dist/inbound";

const SECRET_BINDINGS = [
  "MAIL_BLOB_KEY",
  "SUPABASE_S3_ACCESS_KEY_ID",
  "SUPABASE_S3_SECRET_ACCESS_KEY",
];

/**
 * Metadata for `PUT /accounts/{account_id}/workers/scripts/cumulus-mail-inbound`.
 * Secret bindings are listed by name only. Add `text` locally at upload time.
 * @param {Record<string, any>} wrangler
 */
export function inboundScriptMetadata(wrangler) {
  const plain = Object.entries(wrangler.vars ?? {}).map(([name, text]) => ({
    type: "plain_text",
    name,
    text,
  }));
  const secrets = SECRET_BINDINGS.map((name) => ({ type: "secret_text", name }));
  return {
    main_module: INBOUND_MAIN_MODULE,
    compatibility_date: wrangler.compatibility_date,
    compatibility_flags: wrangler.compatibility_flags,
    bindings: [
      {
        type: "hyperdrive",
        name: wrangler.hyperdrive?.[0]?.binding ?? "HYPERDRIVE",
        id: wrangler.hyperdrive?.[0]?.id,
      },
      ...plain,
      ...secrets,
    ],
  };
}

export async function buildInbound(root = projectRoot()) {
  const wrangler = readWorkerConfig("workers/email/wrangler.jsonc");
  const metadata = inboundScriptMetadata(wrangler);
  if (metadata.compatibility_flags?.includes("nodejs_compat") !== true) {
    throw new Error("Inbound bundle requires compatibility flag nodejs_compat");
  }
  if (
    metadata.bindings.some(
      (binding) => binding.type === "send_email" || binding.type === "r2_bucket",
    )
  ) {
    throw new Error("Inbound bundle must not declare send_email or r2");
  }
  const outDir = join(root, INBOUND_OUT_DIR);
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  const bundle = await rolldown({
    input: join(root, "workers/email/src/index.ts"),
    // Node platform resolves package "main"/"module" and leaves Node builtins
    // external. nodejs_compat provides those imports in the Worker.
    platform: "node",
    external: [/^node:/],
    treeshake: true,
  });
  try {
    await bundle.write({
      file: join(outDir, INBOUND_MAIN_MODULE),
      format: "es",
      codeSplitting: false,
    });
  } finally {
    await bundle.close();
  }
  await writeFile(join(outDir, "metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`);
  return { outDir, metadata };
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : "";
if (invoked === fileURLToPath(import.meta.url)) {
  const { outDir, metadata } = await buildInbound();
  console.log(
    `[inbound] ${metadata.main_module} compatibility_date=${metadata.compatibility_date} flags=${metadata.compatibility_flags.join(",")} bindings=${metadata.bindings.length} -> ${outDir}`,
  );
}
