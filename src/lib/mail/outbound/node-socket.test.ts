import assert from "node:assert/strict";
import { createServer, type Server, type Socket } from "node:net";
import { after, before, test } from "node:test";
import { dialNode } from "./node-socket.ts";

/**
 * A scripted SMTP-ish peer on 127.0.0.1. Each test sets `script` to decide what the server does with a
 * new connection; nothing leaves the machine.
 */
let server: Server;
let port = 0;
let script: (peer: Socket) => void = () => undefined;

before(async () => {
  server = createServer((peer) => script(peer));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;
});
after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("reads the greeting, then replies split across and packed into chunks, in order", async () => {
  script = (peer) => {
    peer.write("220 mx.test ready\r\n");
    peer.on("data", (data) => {
      if (String(data).startsWith("EHLO")) {
        // One reply split mid-line over two writes, then two lines in one write.
        peer.write("250-mx.test hel");
        setTimeout(() => peer.write("lo\r\n250-SIZE 1000\r\n250 STARTTLS\r\n"), 20);
      }
      if (String(data).startsWith("QUIT")) peer.end("221 bye\r\n");
    });
  };
  const smtp = await dialNode("127.0.0.1", port, false);
  assert.equal(await smtp.readLine(), "220 mx.test ready");
  await smtp.write("EHLO client.test\r\n");
  assert.equal(await smtp.readLine(), "250-mx.test hello", "a line split across chunks is joined");
  assert.equal(await smtp.readLine(), "250-SIZE 1000", "two lines in one chunk come out one at a time");
  assert.equal(await smtp.readLine(), "250 STARTTLS");
  await smtp.write("QUIT\r\n");
  assert.equal(await smtp.readLine(), "221 bye");
  await smtp.close();
});

test("a read waiting for data is answered when the line arrives", async () => {
  script = (peer) => setTimeout(() => peer.write("220 late\r\n"), 50);
  const smtp = await dialNode("127.0.0.1", port, false);
  const pending = smtp.readLine(); // queued before any data
  assert.equal(await pending, "220 late");
  await smtp.close();
});

test("a broken connection rejects the waiting read and every read after it", async () => {
  script = (peer) => setTimeout(() => peer.resetAndDestroy(), 30);
  const smtp = await dialNode("127.0.0.1", port, false);
  await assert.rejects(smtp.readLine(), /ECONNRESET|socket hang up|reset/i);
  await assert.rejects(smtp.readLine(), /ECONNRESET|socket hang up|reset/i, "the failure is remembered");
});

test("nothing listening: dialing rejects instead of hanging", async () => {
  const closed = createServer();
  await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
  const deadPort = (closed.address() as { port: number }).port;
  await new Promise<void>((resolve) => closed.close(() => resolve()));
  await assert.rejects(dialNode("127.0.0.1", deadPort, false), /ECONNREFUSED/);
});

test("implicit TLS to a peer that does not speak TLS fails rather than sending in the clear", async () => {
  script = (peer) => peer.write("220 plain text, not TLS\r\n");
  await assert.rejects(dialNode("127.0.0.1", port, true));
});

/**
 * STARTTLS: the upgrade must verify the server's certificate. A peer presenting a self-signed one must
 * be refused, or a network attacker could intercept the session and read the mail. The certificate is
 * made at test time with openssl (no key is committed); the test is skipped where openssl is missing.
 */
test("STARTTLS refuses a server whose certificate is not trusted", async (t) => {
  const { spawnSync } = await import("node:child_process");
  const { mkdtempSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { TLSSocket } = await import("node:tls");
  const dir = mkdtempSync(join(tmpdir(), "smtp-tls-"));
  const made = spawnSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1",
    "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem"),
  ], { stdio: "ignore" });
  if (made.status !== 0) {
    t.skip("openssl is not available");
    return;
  }
  const key = readFileSync(join(dir, "key.pem"));
  const cert = readFileSync(join(dir, "cert.pem"));
  let upgraded = false;
  script = (peer) => {
    peer.write("220 ready\r\n");
    peer.once("data", () => {
      peer.write("220 go ahead\r\n", () => {
        const secure = new TLSSocket(peer, { isServer: true, key, cert });
        secure.on("secure", () => {
          upgraded = true;
        });
        secure.on("error", () => undefined); // the client hangs up when it refuses the certificate
      });
    });
  };
  const smtp = await dialNode("127.0.0.1", port, false);
  assert.equal(await smtp.readLine(), "220 ready");
  await smtp.write("STARTTLS\r\n");
  assert.equal(await smtp.readLine(), "220 go ahead");
  await assert.rejects(smtp.startTls(), /self[- ]signed|certificate/i);
  assert.equal(upgraded, false, "no secure session was established with the untrusted server");
});
