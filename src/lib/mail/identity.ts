import { DEFAULT_CUMULUS_ISSUER } from "../auth/cumulus-issuer.ts";
import { CUMULUS_ID_ACCOUNT_URL } from "../auth/cid-account.ts";

/**
 * Sign-in factors live on Cumulus://ID. Mail never collects a password or PIN; a
 * mailbox may add its own authenticator or security key (encrypted with it).
 */
export type IdentityPosture = {
  issuer: string;
  /** Where people manage their password, PIN, authenticator app and recovery codes. */
  accountUrl: string;
  twoFactor: "delegated-to-cumulus-id";
  methods: Array<"password" | "pin" | "totp">;
  note: string;
};

export function identityPosture(issuer = DEFAULT_CUMULUS_ISSUER): IdentityPosture {
  return {
    issuer,
    accountUrl: CUMULUS_ID_ACCOUNT_URL,
    twoFactor: "delegated-to-cumulus-id",
    methods: ["password", "pin", "totp"],
    note: "Your password, 4-digit PIN and optional authenticator app are managed on Cumulus://ID. This mailbox can also require its own authenticator or security key. That secret is encrypted with the mailbox.",
  };
}
