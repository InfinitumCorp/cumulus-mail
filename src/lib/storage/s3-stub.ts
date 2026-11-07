import type { PutOptions, StorageDriver, StoredObject } from "./adapter.ts";

export type S3StubConfig = {
  bucket: string;
  endpoint?: string;
  region?: string;
};

/**
 * S3 driver stub with the same put(key, body, options) / get(key) / delete(key)
 * signature as the Drive driver. Drive's implementation sends
 * `PutObjectCommand`, `GetObjectCommand`, and `DeleteObjectCommand` through
 * AWS SDK v3. This class does not import that SDK and does not call the network.
 */
export class S3CompatibleStorageDriver implements StorageDriver {
  readonly kind = "s3-stub" as const;
  readonly config: S3StubConfig;

  constructor(config: S3StubConfig) {
    if (!config.bucket.trim()) throw new Error("S3 stub requires a bucket name");
    this.config = config;
  }

  private refuse(): never {
    throw new Error(
      `S3 driver is a stub for bucket "${this.config.bucket}". This preview does not send S3 requests.`,
    );
  }

  async put(_key: string, _body: Uint8Array, _options: PutOptions): Promise<void> {
    this.refuse();
  }

  async get(_key: string): Promise<StoredObject | null> {
    this.refuse();
  }

  async delete(_key: string): Promise<void> {
    this.refuse();
  }
}
