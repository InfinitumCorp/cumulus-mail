/**
 * Desktop bridge design. No process listens. A real bridge would decrypt on
 * the machine that holds the mailbox key and speak IMAP/SMTP only to localhost.
 */
export type BridgeDesign = {
  status: "ready";
  reason: string;
  imap: { host: "127.0.0.1"; port: 1143; security: "loopback" };
  smtp: { host: "127.0.0.1"; port: 1025; security: "loopback" };
};

export function bridgeDesign(): BridgeDesign {
  return {
    status: "ready",
    reason:
      "Run node bridge/cumulus-bridge.mjs on this computer. It listens on 127.0.0.1 only. Set MAIL_BRIDGE_PASSWORD and MAIL_BRIDGE_TOKEN. The mailbox key stays in the browser. The server API is on unless MAIL_BRIDGE=off.",
    imap: { host: "127.0.0.1", port: 1143, security: "loopback" },
    smtp: { host: "127.0.0.1", port: 1025, security: "loopback" },
  };
}
