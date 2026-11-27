/**
 * What "zero-access" has to cover beyond the subject and body. A mailbox with a public key gets its
 * mail sealed on arrival; anything else kept beside the message must not hold the plaintext either.
 */
import { sealHybrid, type HybridPublic } from "./pqc.ts";

/** Headers that repeat the subject. They stay out of a sealed message's stored headers. */
const SUBJECT_HEADERS = new Set(["subject", "thread-topic"]);

export function headersForSealed(headers: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!headers) return headers;
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !SUBJECT_HEADERS.has(name.toLowerCase())));
}

/**
 * An attachment for a sealed mailbox: with a hybrid key it is sealed like the body (the reader opens
 * `application/vnd.cumulus.hybrid` with the mailbox key); with only an OpenPGP key it stays as it is,
 * and the message must not then claim zero-access.
 */
export async function attachmentForSealed(
  bytes: Uint8Array,
  contentType: string,
  hybrid: HybridPublic | undefined,
): Promise<{ bytes: Uint8Array; contentType: string; sealed: boolean }> {
  if (!hybrid) return { bytes, contentType, sealed: false };
  return { bytes: new TextEncoder().encode(await sealHybrid(bytes, hybrid)), contentType: "application/vnd.cumulus.hybrid", sealed: true };
}
