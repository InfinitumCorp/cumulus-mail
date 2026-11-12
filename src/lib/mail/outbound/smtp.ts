import { resultFromReply, type OutboundEnvelope, type OutboundTransport, type RecipientResult } from "./transport.ts";

/** A byte stream to an SMTP server. Node uses node:net/node:tls; tests use a scripted fake. */
export interface SmtpSocket {
  write(data: string): Promise<void>;
  /** Resolve with the next CRLF-terminated line from the server (without CRLF). */
  readLine(): Promise<string>;
  /** Upgrade the connection in place after STARTTLS. */
  startTls(): Promise<void>;
  close(): Promise<void>;
}

export type SmtpDial = (host: string, port: number, implicitTls: boolean) => Promise<SmtpSocket>;

export type SmtpOptions = {
  host: string;
  port: number;
  /** "tls" = implicit TLS (465), "starttls" = upgrade after EHLO (587), "none" only for loopback tests. */
  security: "tls" | "starttls" | "none";
  user?: string;
  password?: string;
  /** Name sent in EHLO. */
  helo: string;
  dial: SmtpDial;
};

type Reply = { code: number; lines: string[] };

async function readReply(socket: SmtpSocket): Promise<Reply> {
  const lines: string[] = [];
  for (;;) {
    const line = await socket.readLine();
    const match = /^(\d{3})([ -])(.*)$/.exec(line);
    if (!match) throw new Error(`SMTP: unreadable reply ${line.slice(0, 80)}`);
    lines.push(match[3] ?? "");
    if (match[2] === " ") return { code: Number(match[1]), lines };
  }
}

async function command(socket: SmtpSocket, line: string): Promise<Reply> {
  await socket.write(`${line}\r\n`);
  return readReply(socket);
}

function expect(reply: Reply, ok: (code: number) => boolean, step: string): void {
  if (!ok(reply.code)) {
    const error = new Error(`SMTP ${step} failed: ${reply.code} ${reply.lines.join(" ")}`.slice(0, 500)) as Error & { code?: number };
    error.code = reply.code;
    throw error;
  }
}

/** RFC 5321 §4.5.2: a line starting with "." gets one more ".". The message ends with CRLF.CRLF. */
export function dotStuff(raw: string): string {
  const body = raw.replace(/\r?\n/g, "\r\n");
  const stuffed = body.replace(/^\./gm, "..");
  return `${stuffed}${stuffed.endsWith("\r\n") ? "" : "\r\n"}.\r\n`;
}

function addressOnly(value: string): string {
  const email = value.trim();
  if (!/^[^\s<>@]+@[^\s<>@]+$/.test(email)) throw new Error("SMTP: invalid address");
  return email;
}

export function createSmtpTransport(options: SmtpOptions): OutboundTransport {
  return {
    name: `smtp:${options.host}`,
    async send(envelope: OutboundEnvelope): Promise<RecipientResult[]> {
      const results: RecipientResult[] = [];
      let socket: SmtpSocket | null = null;
      try {
        socket = await options.dial(options.host, options.port, options.security === "tls");
        expect(await readReply(socket), (code) => code === 220, "greeting");
        let ehlo = await command(socket, `EHLO ${options.helo}`);
        expect(ehlo, (code) => code === 250, "EHLO");
        if (options.security === "starttls") {
          if (!ehlo.lines.some((line) => /^STARTTLS\b/i.test(line))) throw new Error("SMTP server does not offer STARTTLS");
          expect(await command(socket, "STARTTLS"), (code) => code === 220, "STARTTLS");
          await socket.startTls();
          ehlo = await command(socket, `EHLO ${options.helo}`);
          expect(ehlo, (code) => code === 250, "EHLO after STARTTLS");
        }
        if (options.user) {
          const token = Buffer.from(`\u0000${options.user}\u0000${options.password ?? ""}`).toString("base64");
          expect(await command(socket, `AUTH PLAIN ${token}`), (code) => code === 235, "AUTH");
        }
        expect(await command(socket, `MAIL FROM:<${addressOnly(envelope.from)}>`), (code) => code === 250, "MAIL FROM");
        const accepted: string[] = [];
        for (const recipient of envelope.to) {
          const reply = await command(socket, `RCPT TO:<${addressOnly(recipient)}>`);
          if (reply.code === 250 || reply.code === 251) accepted.push(recipient);
          else results.push(resultFromReply(recipient, reply.code, reply.lines.join(" ")));
        }
        if (accepted.length) {
          expect(await command(socket, "DATA"), (code) => code === 354, "DATA");
          await socket.write(dotStuff(envelope.raw));
          const done = await readReply(socket);
          for (const recipient of accepted) results.push(resultFromReply(recipient, done.code, done.lines.join(" ")));
          accepted.length = 0;
        }
        await command(socket, "QUIT").catch(() => undefined);
        return results;
      } catch (error) {
        // A failure before or during the transaction applies to every recipient not yet answered.
        const code = (error as { code?: number }).code ?? 451;
        const text = error instanceof Error ? error.message : "SMTP failed";
        const answered = new Set(results.map((result) => result.recipient));
        return [
          ...results,
          ...envelope.to
            .filter((recipient) => !answered.has(recipient))
            .map((recipient) => resultFromReply(recipient, code >= 500 ? code : 451, text)),
        ];
      } finally {
        await socket?.close().catch(() => undefined);
      }
    },
  };
}
