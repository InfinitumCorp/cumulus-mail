import { generateKeyPairSync } from "node:crypto";
import { dkimSign, type DNSResolver } from "mailauth";

/** A signed message plus a resolver that never calls the network. */
export async function signedInbound(options: {
  from: string;
  to: string;
  subject: string;
  text: string;
  filename: string;
  attachment: string;
  policy?: string;
}): Promise<{ raw: Uint8Array; resolver: DNSResolver }> {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" });
  const p = Buffer.from(publicKey.export({ type: "spki", format: "der" })).toString("base64");
  const attachment = Buffer.from(options.attachment).toString("base64");
  const raw = [
    `From: ${options.from}`,
    `To: ${options.to}`,
    `Subject: ${options.subject}`,
    "Date: Sat, 07 Nov 2026 12:00:00 +0000",
    "Message-ID: <runtime@example.test>",
    "MIME-Version: 1.0",
    "Content-Type: multipart/mixed; boundary=cumulus",
    "",
    "--cumulus",
    "Content-Type: text/plain; charset=utf-8",
    "",
    options.text,
    "--cumulus",
    `Content-Type: text/plain; name="${options.filename}"`,
    "Content-Transfer-Encoding: base64",
    `Content-Disposition: attachment; filename="${options.filename}"`,
    "",
    attachment,
    "--cumulus--",
    "",
  ].join("\r\n");
  const signed = await dkimSign(raw, {
    signatureData: [{ signingDomain: "example.test", selector: "mail", privateKey: pem }],
  });
  const records: Record<string, string> = {
    "txt mail._domainkey.example.test": `v=DKIM1; k=rsa; p=${p}`,
    "txt example.test": "v=spf1 ip4:192.0.2.10 -all",
    "txt _dmarc.example.test": `v=DMARC1; p=${options.policy ?? "reject"}; adkim=r; aspf=r`,
  };
  const resolver: DNSResolver = async (domain, rrtype) => {
    const hit = records[`${rrtype} ${domain}`.toLowerCase()];
    return hit ? [[hit]] : [];
  };
  const message = `${signed.signatures}${raw}`;
  return { raw: new TextEncoder().encode(message), resolver };
}
