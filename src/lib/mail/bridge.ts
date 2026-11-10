/**
 * Desktop bridge design. No process listens. A real bridge would decrypt on
 * the machine that holds the mailbox key and speak IMAP/SMTP only to localhost.
 */
export type BridgeDesign = {
  status: "deferred";
  reason: string;
  imap: { host: "127.0.0.1"; port: 1143; security: "STARTTLS" };
  smtp: { host: "127.0.0.1"; port: 1025; security: "STARTTLS" };
};

export function bridgeDesign(): BridgeDesign {
  return {
    status: "deferred",
    reason:
      "IMAP and SMTP stay on a local bridge so the server never hands a desktop client the mailbox key. That bridge is not running in this deployment.",
    imap: { host: "127.0.0.1", port: 1143, security: "STARTTLS" },
    smtp: { host: "127.0.0.1", port: 1025, security: "STARTTLS" },
  };
}
