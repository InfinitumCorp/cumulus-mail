/**
 * A tiny in-memory S3 stand-in for the deploy dry run (scripts/deploy-dry-run.mjs): path-style
 * HeadBucket, CreateBucket, PutObject, GetObject, HeadObject, DeleteObject. Signatures are not checked.
 * Local smoke tests only; never a storage backend.
 */
import { createServer } from "node:http";

export function startFakeS3(port = 0) {
  const buckets = new Map();
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const [bucket, ...rest] = decodeURIComponent(new URL(req.url, "http://x").pathname).slice(1).split("/");
    const key = rest.join("/");
    const store = buckets.get(bucket);
    if (!key) {
      if (req.method === "PUT") buckets.set(bucket, store ?? new Map());
      res.writeHead(req.method === "PUT" || store ? 200 : 404).end();
      return;
    }
    if (!store) return void res.writeHead(404, { "content-type": "application/xml" }).end("<Error><Code>NoSuchBucket</Code></Error>");
    if (req.method === "PUT") {
      store.set(key, body);
      return void res.writeHead(200, { etag: '"x"' }).end();
    }
    if (req.method === "DELETE") {
      store.delete(key);
      return void res.writeHead(204).end();
    }
    const object = store.get(key);
    if (!object) return void res.writeHead(404, { "content-type": "application/xml" }).end("<Error><Code>NoSuchKey</Code></Error>");
    res.writeHead(200, { "content-length": object.length, "content-type": "application/octet-stream" });
    res.end(req.method === "HEAD" ? undefined : object);
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({ server, port: server.address().port, buckets })));
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  const { port } = await startFakeS3(Number(process.argv[2] ?? 0));
  console.log(`[fake-s3] listening on 127.0.0.1:${port}`);
}
