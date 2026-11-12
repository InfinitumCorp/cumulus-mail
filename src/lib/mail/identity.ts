/** Mail signs people in with Google; a second factor is whatever their Google account enforces. */
export const SIGN_IN_ISSUER = "https://accounts.google.com";

/**
 * Sign-in factors live on the Google account. Mail does not collect a second
 * password, TOTP secret, or security-key attestation.
 */
export type IdentityPosture = {
  issuer: string;
  twoFactor: "delegated-to-google";
  methods: Array<"totp" | "security-key" | "passkey">;
  note: string;
};

export function identityPosture(issuer = SIGN_IN_ISSUER): IdentityPosture {
  return {
    issuer,
    twoFactor: "delegated-to-google",
    methods: ["totp", "security-key", "passkey"],
    note: "Two-step verification, passkeys, and security keys are set up on your Google account. This mailbox trusts that sign-in and does not store a second factor.",
  };
}
