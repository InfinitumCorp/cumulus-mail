import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  ChecksumMismatchError,
  sha256Hex,
  splitStorageKey,
  type ObjectHead,
  type StorageDriver,
  type StoredObject,
} from "./adapter.ts";

const META_SUFFIX = ".cumulus-meta.json";

type MetaFile = {
  contentType: string;
  checksumHex: string;
  size: number;
  updatedAt: string;
};

/**
 * Local-disk driver. A put writes a temp file in the same directory and renames
 * it into place, so readers never observe a partial object. Layout:
 * `<root>/tenant/<tenantId>/<objectKey>` plus a sibling metadata file.
 */
export class LocalDiskStorageDriver implements StorageDriver {
  private readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  private pathFor(key: string): string {
    const parts = splitStorageKey(key);
    return join(this.root, "tenant", parts.tenantId, ...parts.objectKey.split("/"));
  }

  async put(key: string, body: Uint8Array, options: { contentType?: string; checksumSha256: string }): Promise<void> {
    const actual = await sha256Hex(body);
    if (actual !== options.checksumSha256.toLowerCase()) {
      throw new ChecksumMismatchError(key);
    }
    const { tenantId, objectKey } = splitStorageKey(key);
    const dest = this.pathFor(key);
    const metaPath = `${dest}${META_SUFFIX}`;
    await mkdir(dirname(dest), { recursive: true });
    const token = randomBytes(8).toString("hex");
    const tmp = join(dirname(dest), `.${token}.partial`);
    const metaTmp = `${tmp}.meta`;
    const head: ObjectHead = {
      key,
      tenantId,
      objectKey,
      size: body.byteLength,
      checksumSha256: actual,
      contentType: options.contentType?.trim() || "application/octet-stream",
      updatedAt: new Date().toISOString(),
    };
    const meta: MetaFile = {
      contentType: head.contentType,
      checksumHex: actual,
      size: head.size,
      updatedAt: head.updatedAt,
    };
    await writeFile(tmp, body);
    await writeFile(metaTmp, JSON.stringify(meta));
    await rename(tmp, dest);
    await rename(metaTmp, metaPath);
  }

  async head(key: string): Promise<ObjectHead | null> {
    const { tenantId, objectKey } = splitStorageKey(key);
    try {
      const raw = await readFile(`${this.pathFor(key)}${META_SUFFIX}`, "utf8");
      const meta = JSON.parse(raw) as MetaFile;
      return {
        key,
        tenantId,
        objectKey,
        size: meta.size,
        checksumSha256: meta.checksumHex,
        contentType: meta.contentType,
        updatedAt: meta.updatedAt,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async get(key: string): Promise<StoredObject | null> {
    const head = await this.head(key);
    if (!head) return null;
    let body: Buffer;
    try {
      body = await readFile(this.pathFor(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const bytes = new Uint8Array(body);
    const actual = await sha256Hex(bytes);
    if (actual !== head.checksumSha256 || bytes.byteLength !== head.size) {
      throw new ChecksumMismatchError(key);
    }
    return {
      key,
      body: bytes,
      contentType: head.contentType,
      checksumSha256: head.checksumSha256,
      size: bytes.byteLength,
    };
  }

  async delete(key: string): Promise<void> {
    const dest = this.pathFor(key);
    await rm(dest, { force: true });
    await rm(`${dest}${META_SUFFIX}`, { force: true });
  }

  async list(prefix: string): Promise<ObjectHead[]> {
    const match = /^tenant\/([^/]+)\/?(.*)$/.exec(prefix);
    if (!match?.[1]) return [];
    const tenantId = match[1];
    const dir = join(this.root, "tenant", tenantId);
    const found: ObjectHead[] = [];
    await this.walk(dir, `tenant/${tenantId}/`, found);
    return found.filter((head) => head.key.startsWith(prefix));
  }

  private async walk(dir: string, baseKey: string, out: ObjectHead[]): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.name.endsWith(META_SUFFIX) || entry.name.endsWith(".partial") || entry.name.endsWith(".meta")) {
        continue;
      }
      if (entry.isDirectory()) {
        await this.walk(join(dir, entry.name), `${baseKey}${entry.name}/`, out);
        continue;
      }
      const key = `${baseKey}${entry.name}`;
      const head = await this.head(key);
      if (head) out.push(head);
    }
  }
}
