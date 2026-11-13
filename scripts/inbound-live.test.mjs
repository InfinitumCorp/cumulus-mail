import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertSessionPooler,
  inboundLiveEnabled,
  liveConnectionString,
  liveS3,
} from "./inbound-live.mjs";
import { DEFAULT_CUMULUS_ISSUER } from "../src/lib/auth/issuer-defaults.mjs";

const POOLER =
  "postgresql://postgres.ivqiskeziohbbtkcvlun:secret@aws-0-us-east-1.pooler.supabase.com:5432/postgres?sslmode=require";

test("the live inbound path stays off unless MAIL_INBOUND_LIVE=1", () => {
  assert.equal(inboundLiveEnabled({}), false);
  assert.equal(inboundLiveEnabled({ MAIL_INBOUND_LIVE: "true" }), false);
  assert.equal(inboundLiveEnabled({ MAIL_INBOUND_LIVE: "1" }), true);
  assert.equal(
    liveConnectionString({ DATABASE_URL: "postgres://db.example/mail" }),
    "postgres://db.example/mail",
  );
  assert.equal(
    liveConnectionString({
      DATABASE_URL: "postgres://other/mail",
      HYPERDRIVE_CONNECTION_STRING: POOLER,
    }),
    POOLER,
  );
  assert.equal(liveS3({ SUPABASE_S3_BUCKET: "cumulus-mail" }).bucket, "cumulus-mail");
  assert.equal(liveS3({}).bucket, "cumulus-mail");
});

test("the live database URL must be the session pooler with sslmode=require", () => {
  assert.equal(assertSessionPooler(POOLER), POOLER);
  assert.throws(() => assertSessionPooler(POOLER.replace(":5432", ":6543")), /5432/);
  assert.throws(
    () => assertSessionPooler(POOLER.replace("sslmode=require", "sslmode=disable")),
    /sslmode=disable/,
  );
  assert.throws(
    () => assertSessionPooler(POOLER.replace("?sslmode=require", "")),
    /sslmode=require/,
  );
  assert.equal(
    assertSessionPooler("postgres://postgres:postgres@127.0.0.1:5432/cumulus_mail"),
    "postgres://postgres:postgres@127.0.0.1:5432/cumulus_mail",
  );
});

test("docs and smoke default the OIDC issuer to Cumulus://ID's own realm", () => {
  assert.equal(DEFAULT_CUMULUS_ISSUER, "https://id.cumuluscloud.app/realms/cumulus");
});
