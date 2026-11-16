/** Argument parsing for `npm run keys:rekey` (scripts/rekey.mjs), kept apart so it is testable. */
export const USAGE = `Usage: npm run keys:rekey -- [--apply] [--batch <n>] [--from-tenant <id>]

Re-seals stored fields and blobs under the current key in MAIL_BLOB_KEYS.
Dry run by default: counts values per key and changes nothing.
  --apply              re-seal values that are not under the current key
  --batch <n>          mailboxes per batch (1-1000, default 50)
  --from-tenant <id>   resume after this mailbox (the last one a previous run printed)`;

export function parseRekeyArgs(argv) {
  const options = { apply: false, batchSize: 50, fromTenant: undefined, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) throw new Error(`${arg} needs a value`);
      i += 1;
      return next;
    };
    if (arg === "--apply") options.apply = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--batch") {
      const n = Number(value());
      if (!Number.isInteger(n) || n < 1 || n > 1000) throw new Error("--batch is a whole number from 1 to 1000");
      options.batchSize = n;
    } else if (arg === "--from-tenant") {
      const id = value();
      if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw new Error("--from-tenant is a mailbox id");
      options.fromTenant = id;
    } else throw new Error(`Unknown option ${arg}`);
  }
  return options;
}
