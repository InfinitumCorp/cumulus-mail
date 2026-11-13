import type { CfConnect, CfSocket } from "./cf-socket.ts";

/** A fake `cloudflare:sockets` connect: a scripted SMTP server over web streams. */
/** Test support only. */
export function fakeConnect(log: { connects: Array<{ host: string; port: number; secure: string }>; lines: string[]; tls: number }): CfConnect {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  // A real server greets once; after STARTTLS the client speaks first (EHLO).
  const make = (greet: boolean): CfSocket => {
    let push: (text: string) => void = () => {};
    let end: () => void = () => {};
    const readable = new ReadableStream<Uint8Array>({
      start(controller) {
        push = (text) => controller.enqueue(encoder.encode(text));
        end = () => controller.close();
      },
    });
    let inData = false;
    let pending = "";
    const writable = new WritableStream<Uint8Array>({
      write(chunk) {
        pending += decoder.decode(chunk);
        if (inData) {
          if (!pending.endsWith("\r\n.\r\n")) return;
          log.lines.push(`<data ${pending.length} bytes>`);
          pending = "";
          inData = false;
          push("250 2.0.0 queued\r\n");
          return;
        }
        for (const line of pending.split("\r\n").filter(Boolean)) {
          log.lines.push(line);
          const verb = line.split(/[ :]/)[0]!.toUpperCase();
          if (verb === "EHLO") push(log.tls ? "250-mx.test\r\n250 AUTH PLAIN\r\n" : "250-mx.test\r\n250 STARTTLS\r\n");
          else if (verb === "STARTTLS") push("220 go ahead\r\n");
          else if (verb === "AUTH") push("235 ok\r\n");
          else if (verb === "DATA") {
            inData = true;
            push("354 send\r\n");
          } else if (verb === "QUIT") {
            push("221 bye\r\n");
            end();
          } else push("250 ok\r\n");
        }
        pending = "";
      },
    });
    const socket: CfSocket = {
      readable,
      writable,
      opened: Promise.resolve(),
      startTls() {
        log.tls += 1;
        return make(false);
      },
      async close() {},
    };
    if (greet) queueMicrotask(() => push("220 mx.test ESMTP\r\n"));
    return socket;
  };
  return (address, options) => {
    log.connects.push({ host: address.hostname, port: address.port, secure: options.secureTransport });
    return make(true);
  };
}
