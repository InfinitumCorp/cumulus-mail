/** IMAP4rev1 subset for the local bridge. Loopback only. Reads the mailbox the token can see. */

export type BridgeFolder = { name: string; messages: BridgeMail[] };
export type BridgeMail = { uid: number; subject: string; from: string; to: string; body: string; seen: boolean; bytes: number };

export type ImapSession = { authed: boolean; folder: string | null };

export function assertLoopback(host: string): void {
  if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost") {
    throw new Error("The bridge listens on 127.0.0.1 only");
  }
}

export function parseImap(line: string): { tag: string; command: string; rest: string } | null {
  const match = /^([A-Za-z0-9]{1,20})\s+([A-Za-z]+)\s*(.*)$/.exec(line.trim());
  if (!match) return null;
  return { tag: match[1]!, command: match[2]!.toUpperCase(), rest: match[3] ?? "" };
}

function quote(value: string): string {
  return `"${value.replace(/[\r\n"\\]/g, " ")}"`;
}

/**
 * One client line in, zero or more server lines out.
 * LOGIN checks the local bridge password. It is not the Cumulus ID password and not the mailbox key.
 */
export function imapStep(
  session: ImapSession,
  line: string,
  password: string,
  folders: BridgeFolder[],
): string[] {
  const parsed = parseImap(line);
  if (!parsed) return ["* BAD command"];
  const { tag, command, rest } = parsed;
  if (command === "CAPABILITY") return ["* CAPABILITY IMAP4rev1", `${tag} OK CAPABILITY`];
  if (command === "NOOP") return [`${tag} OK NOOP`];
  if (command === "LOGOUT") return ["* BYE", `${tag} OK LOGOUT`];
  if (command === "LOGIN") {
    const offered = rest.split(/\s+/).slice(1).join(" ").replace(/^"|"$/g, "");
    if (offered !== password) return [`${tag} NO LOGIN`];
    session.authed = true;
    return [`${tag} OK LOGIN`];
  }
  if (!session.authed) return [`${tag} NO login required`];
  if (command === "LIST" || command === "LSUB") {
    return [...folders.map((folder) => `* LIST () "/" ${quote(folder.name)}`), `${tag} OK LIST`];
  }
  if (command === "SELECT" || command === "EXAMINE") {
    const name = rest.replace(/^"|"$/g, "");
    const folder = folders.find((item) => item.name.toLowerCase() === name.toLowerCase());
    if (!folder) return [`${tag} NO no such mailbox`];
    session.folder = folder.name;
    return [`* ${folder.messages.length} EXISTS`, `* OK [UIDVALIDITY 1]`, `${tag} OK [READ-ONLY] ${command}`];
  }
  const selected = folders.find((item) => item.name === session.folder);
  if ((command === "FETCH" || command === "UID") && selected) {
    const uid = Number(/^UID\s+FETCH\s+(\d+)/i.test(rest) ? /^UID\s+FETCH\s+(\d+)/i.exec(rest)?.[1] : rest.split(/\s+/)[0]);
    const mail = selected.messages.find((item) => item.uid === uid) ?? selected.messages[0];
    if (!mail) return [`${tag} OK FETCH`];
    const header = `From: ${mail.from}\r\nTo: ${mail.to}\r\nSubject: ${mail.subject}\r\n\r\n${mail.body}`;
    return [
      `* ${mail.uid} FETCH (UID ${mail.uid} FLAGS (${mail.seen ? "\\Seen" : ""}) RFC822.SIZE ${header.length} BODY[] {${header.length}}`,
      header,
      ")",
      `${tag} OK FETCH`,
    ];
  }
  if (["STORE", "COPY", "MOVE", "APPEND", "EXPUNGE", "CREATE", "DELETE", "RENAME"].includes(command)) {
    return [`${tag} NO [CANNOT] read-only bridge`];
  }
  return [`${tag} BAD unsupported`];
}
