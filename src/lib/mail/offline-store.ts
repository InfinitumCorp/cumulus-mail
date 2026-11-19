/**
 * Encrypted offline copy. The service worker still does not cache mail.
 * The page stores this blob in IndexedDB and opens it with the same passphrase as the mailbox key.
 */

const PREFIX = "cmo1.";

function view(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function b64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromB64(value: string): Uint8Array {
  const pad = value.length % 4 === 0 ? "" : "=".repeat(4 - (value.length % 4));
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function keyFrom(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", view(new TextEncoder().encode(passphrase)), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: view(salt), iterations: 100_000, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function sealOffline(json: string, passphrase: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await keyFrom(passphrase, salt);
  const box = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: view(iv) }, key, view(new TextEncoder().encode(json))));
  const packed = new Uint8Array(salt.length + iv.length + box.length);
  packed.set(salt, 0);
  packed.set(iv, salt.length);
  packed.set(box, salt.length + iv.length);
  return PREFIX + b64(packed);
}

export async function openOffline(sealed: string, passphrase: string): Promise<string> {
  if (!sealed.startsWith(PREFIX)) throw new Error("Not an offline mailbox");
  const bytes = fromB64(sealed.slice(PREFIX.length));
  const key = await keyFrom(passphrase, bytes.slice(0, 16));
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: view(bytes.slice(16, 28)) }, key, view(bytes.slice(28)));
  return new TextDecoder().decode(plain);
}

const DB = "cumulus-mail";
const STORE = "offline";

export function saveOfflineBlob(sealed: string): Promise<void> {
  return idb((db) => {
    db.transaction(STORE, "readwrite").objectStore(STORE).put(sealed, "mailbox");
  });
}

export function loadOfflineBlob(): Promise<string | null> {
  return idb(
    (db) =>
      new Promise((resolve) => {
        const request = db.transaction(STORE).objectStore(STORE).get("mailbox");
        request.onsuccess = () => resolve(typeof request.result === "string" ? request.result : null);
        request.onerror = () => resolve(null);
      }),
  );
}

function idb<T>(run: (db: IDBDatabase) => T | Promise<T>): Promise<T> {
  if (typeof indexedDB === "undefined") return Promise.reject(new Error("Offline storage is not available"));
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(STORE);
    open.onerror = () => reject(open.error ?? new Error("Could not open offline storage"));
    open.onsuccess = () => {
      Promise.resolve(run(open.result)).then(resolve, reject);
    };
  });
}
