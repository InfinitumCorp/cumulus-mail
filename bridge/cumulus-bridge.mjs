#!/usr/bin/env node
/**
 * Local IMAP bridge. Listens on 127.0.0.1 only.
 *
 *   MAIL_BRIDGE_PASSWORD=... MAIL_BRIDGE_TOKEN=cmb_... node bridge/cumulus-bridge.mjs
 *
 * The password is the one Thunderbird uses against localhost. The token is an
 * app password from the account dialog. The mailbox key never leaves the browser.
 * SMTP submission is not opened: sending stays in the web app, which can seal mail.
 */
import net from "node:net";
import { assertLoopback, imapStep, type BridgeFolder, type ImapSession } from "../src/lib/mail/bridge/imap-core.ts";

const host = process.env.MAIL_BRIDGE_BIND || "127.0.0.1";
const port = Number(process.env.MAIL_BRIDGE_IMAP_PORT || 1143);
const password = process.env.MAIL_BRIDGE_PASSWORD || "";
assertLoopback(host);
if (password.length < 8) {
  console.error("Set MAIL_BRIDGE_PASSWORD to at least 8 characters.");
  process.exit(1);
}

const folders: BridgeFolder[] = [{ name: "INBOX", messages: [] }];
const server = net.createServer((socket) => {
  const session: ImapSession = { authed: false, folder: null };
  socket.write("* OK Cumulus Mail bridge\r\n");
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let nl = buffer.indexOf("\n");
    while (nl >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      for (const reply of imapStep(session, line, password, folders)) socket.write(`${reply}\r\n`);
      nl = buffer.indexOf("\n");
    }
  });
});
server.listen(port, host, () => {
  console.log(`IMAP on ${host}:${port}`);
});
