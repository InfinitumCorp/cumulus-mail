import type { SmtpDial, SmtpSocket } from "./smtp.ts";

/** The parts of Cloudflare's `cloudflare:sockets` Socket that SMTP needs. */
export type CfSocket = {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  opened: Promise<unknown>;
  startTls(): CfSocket;
  close(): Promise<void>;
};

export type CfConnect = (
  address: { hostname: string; port: number },
  options: { secureTransport: "on" | "off" | "starttls"; allowHalfOpen: boolean },
) => CfSocket;

/**
 * SmtpDial over Cloudflare Workers TCP sockets (`connect` from `cloudflare:sockets`).
 * Implicit TLS uses `secureTransport: "on"`; STARTTLS opens with "starttls" and
 * upgrades with `socket.startTls()` when the SMTP client asks.
 */
export function dialWith(connect: CfConnect): SmtpDial {
  return async (host, port, implicitTls) => {
    let socket = connect({ hostname: host, port }, { secureTransport: implicitTls ? "on" : "starttls", allowHalfOpen: false });
    await socket.opened;
    let reader = socket.readable.getReader();
    let writer = socket.writable.getWriter();
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let buffer = "";

    const api: SmtpSocket = {
      async write(data) {
        await writer.write(encoder.encode(data));
      },
      async readLine() {
        for (;;) {
          const at = buffer.indexOf("\r\n");
          if (at >= 0) {
            const line = buffer.slice(0, at);
            buffer = buffer.slice(at + 2);
            return line;
          }
          const { value, done } = await reader.read();
          if (done) throw new Error("SMTP connection closed");
          buffer += decoder.decode(value, { stream: true });
        }
      },
      async startTls() {
        // The plain-text streams must be released before the socket can upgrade.
        reader.releaseLock();
        writer.releaseLock();
        socket = socket.startTls();
        await socket.opened;
        reader = socket.readable.getReader();
        writer = socket.writable.getWriter();
        buffer = "";
      },
      async close() {
        try {
          reader.releaseLock();
          writer.releaseLock();
        } catch {
          // Already released.
        }
        await socket.close();
      },
    };
    return api;
  };
}

/** The Workers dialer, loaded only on Workers (the module does not exist in Node). */
export const dialCloudflare: SmtpDial = async (host, port, implicitTls) => {
  const specifier = "cloudflare:sockets";
  const sockets = (await import(/* @vite-ignore */ specifier)) as { connect: CfConnect };
  return dialWith(sockets.connect)(host, port, implicitTls);
};
