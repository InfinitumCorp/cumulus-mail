/** HMAC token index. The stored tokens are not the words themselves. */

export function tokensOf(text: string): string[] {
  const found = text.toLowerCase().match(/[a-z0-9@._+-]{2,}/g) ?? [];
  return [...new Set(found)].slice(0, 400);
}

async function hmac(secret: string, token: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(token));
  return [...new Uint8Array(mac)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function buildSearchIndex(text: string, secret: string): Promise<string[]> {
  const tokens = tokensOf(text);
  const index: string[] = [];
  for (const token of tokens) index.push(await hmac(secret, token));
  return index;
}

export async function queryIndex(index: string[], secret: string, query: string): Promise<boolean> {
  const tokens = tokensOf(query);
  if (!tokens.length) return true;
  for (const token of tokens) {
    const mac = await hmac(secret, token);
    if (!index.includes(mac)) return false;
  }
  return true;
}

/** True when a stored index accidentally kept a plaintext word. */
export function indexContainsPlaintext(index: string[], text: string): boolean {
  const words = new Set(tokensOf(text));
  return index.some((token) => words.has(token.toLowerCase()));
}
