import { DEFAULT_CUMULUS_ISSUER } from "../auth/cumulus-issuer.ts";

/**
 * Sign-in factors live on Cumulus://ID. Mail does not collect a second password,
 * TOTP secret, or security-key attestation.
 */
export type IdentityPosture = {
  issuer: string;
  twoFactor: "delegated-to-cumulus-id";
  methods: Array<"totp" | "security-key" | "passkey">;
  note: string;
};

export function identityPosture(issuer = DEFAULT_CUMULUS_ISSUER): IdentityPosture {
  return {
    issuer,
    twoFactor: "delegated-to-cumulus-id",
    methods: ["totp", "security-key", "passkey"],
    note: "Cumulus://ID enrolls authenticator codes, passkeys, and security keys. This mailbox can also require its own authenticator or security key. That secret is encrypted with the mailbox.",
  };
}
