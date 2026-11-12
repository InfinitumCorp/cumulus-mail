import assert from "node:assert/strict";
import { test } from "node:test";
import { dialWith } from "./cf-socket.ts";
import { fakeConnect } from "./cf-fake.ts";
import { createSmtpTransport } from "./smtp.ts";

test("SMTP over Workers sockets: STARTTLS upgrades the stream and the message is accepted", async () => {
  const log = { connects: [] as Array<{ host: string; port: number; secure: string }>, lines: [] as string[], tls: 0 };
  const transport = createSmtpTransport({
    host: "smtp.example.org",
    port: 587,
    security: "starttls",
    user: "relay",
    password: "pw",
    helo: "cumuluscloud.app",
    dial: dialWith(fakeConnect(log)),
  });
  const results = await transport.send({ from: "ada@cumuluscloud.app", to: ["bea@example.org"], raw: "Subject: hi\r\n\r\nhello\r\n" });
  assert.deepEqual(results.map((result) => result.ok), [true]);
  assert.deepEqual(log.connects, [{ host: "smtp.example.org", port: 587, secure: "starttls" }]);
  assert.equal(log.tls, 1);
  assert.deepEqual(log.lines.slice(0, 4), ["EHLO cumuluscloud.app", "STARTTLS", "EHLO cumuluscloud.app", `AUTH PLAIN ${Buffer.from("\0relay\0pw").toString("base64")}`]);
  assert.ok(log.lines.includes("RCPT TO:<bea@example.org>"));
  assert.ok(log.lines.some((line) => line.startsWith("<data ")));
});

test("implicit TLS asks Workers for a TLS socket from the start", async () => {
  const log = { connects: [] as Array<{ host: string; port: number; secure: string }>, lines: [] as string[], tls: 1 };
  const transport = createSmtpTransport({ host: "smtp.example.org", port: 465, security: "tls", helo: "x.example", dial: dialWith(fakeConnect(log)) });
  const [result] = await transport.send({ from: "ada@cumuluscloud.app", to: ["bea@example.org"], raw: "x" });
  assert.equal(result?.ok, true);
  assert.equal(log.connects[0]?.secure, "on");
});
