import type { SmtpDial, SmtpSocket } from "./smtp.ts";

/**
 * SmtpDial for Node (and Workers with nodejs_compat) over node:net / node:tls.
 * Imported lazily so nothing opens a socket unless SMTP is configured.
 */
export const dialNode: SmtpDial = async (host, port, implicitTls) => {
  const net = await import("node:net");
  const tls = await import("node:tls");
  let socket: import("node:net").Socket = implicitTls
    ? tls.connect({ host, port, servername: host })
    : net.connect({ host, port });
  await new Promise<void>((resolve, reject) => {
    socket.once(implicitTls ? "secureConnect" : "connect", () => resolve());
    socket.once("error", reject);
  });
  socket.setTimeout(30_000, () => socket.destroy(new Error("SMTP timeout")));

  let buffer = "";
  const waiting: Array<(line: string) => void> = [];
  const failures: Array<(error: Error) => void> = [];
  let failed: Error | null = null;
  const attach = (stream: import("node:net").Socket) => {
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      buffer += chunk;
      let at = buffer.indexOf("\r\n");
      while (at >= 0 && waiting.length) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        failures.shift();
        waiting.shift()?.(line);
        at = buffer.indexOf("\r\n");
      }
    });
    stream.on("error", (error: Error) => {
      failed = error;
      for (const fail of failures.splice(0)) fail(error);
      waiting.length = 0;
    });
  };
  attach(socket);

  const api: SmtpSocket = {
    write: (data) =>
      new Promise((resolve, reject) => socket.write(data, (error) => (error ? reject(error) : resolve()))),
    readLine: () =>
      new Promise((resolve, reject) => {
        if (failed) return reject(failed);
        const at = buffer.indexOf("\r\n");
        if (at >= 0) {
          const line = buffer.slice(0, at);
          buffer = buffer.slice(at + 2);
          return resolve(line);
        }
        waiting.push(resolve);
        failures.push(reject);
      }),
    startTls: async () => {
      socket.removeAllListeners("data");
      const upgraded = tls.connect({ socket, servername: host });
      await new Promise<void>((resolve, reject) => {
        upgraded.once("secureConnect", () => resolve());
        upgraded.once("error", reject);
      });
      socket = upgraded;
      buffer = "";
      attach(upgraded);
    },
    close: async () => {
      socket.end();
    },
  };
  return api;
};
