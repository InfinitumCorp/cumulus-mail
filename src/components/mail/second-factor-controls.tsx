import { useCallback, useEffect, useState } from "react";
import { secondFactor } from "@/lib/mail/api";

type Status = { totp: boolean; pending: boolean; credentials: Array<{ id: string; name: string }>; satisfied: boolean };

function bytesOf(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function textOf(bytes: ArrayBuffer): string {
  let binary = "";
  const view = new Uint8Array(bytes);
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/**
 * Pass the mailbox's second factor with a security key on this device (the locked screen's other way
 * in, beside a code). Resolves once the server has checked the key.
 */
export async function unlockWithSecurityKey(): Promise<void> {
  const options = (await secondFactor({ data: { action: "webauthn-assert-options" } })) as {
    challenge: string;
    rpId: string;
    credentialIds: string[];
  };
  const got = await navigator.credentials.get({
    publicKey: {
      challenge: bytesOf(options.challenge),
      rpId: options.rpId,
      allowCredentials: options.credentialIds.map((id) => ({ type: "public-key" as const, id: bytesOf(id) })),
      timeout: 60_000,
      userVerification: "preferred",
    },
  });
  if (!got || got.type !== "public-key") throw new Error("No security key answered.");
  const credential = got as PublicKeyCredential;
  const assertion = credential.response as AuthenticatorAssertionResponse;
  await secondFactor({
    data: {
      action: "webauthn-assert",
      id: credential.id,
      clientDataJSON: textOf(assertion.clientDataJSON),
      authenticatorData: textOf(assertion.authenticatorData),
      signature: textOf(assertion.signature),
    },
  });
}

/**
 * Mailbox authenticator and security keys. Sits in the account dialog with the same rows as the rest.
 * Cumulus://ID remains the sign-in. This is a second check on the mailbox itself.
 */
export function SecondFactorControls({ onUnlocked }: { onUnlocked?: () => void }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [setup, setSetup] = useState<{ secret: string; otpauth: string } | null>(null);
  const [recovery, setRecovery] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const next = (await secondFactor({ data: { action: "status" } })) as Status;
    setStatus(next);
  }, []);

  useEffect(() => {
    void load().catch((problem: unknown) => setError(problem instanceof Error ? problem.message : "Could not load the second factor."));
  }, [load]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "Could not update the second factor.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border-b border-line py-4">
      <dt className="text-muted">Second factor</dt>
      <dd className="mt-3 flex flex-col gap-3">
        <p className="text-sm text-muted">
          {status?.totp ? "Authenticator is on." : "Authenticator is off."} {status?.credentials.length ? `${status.credentials.length} security key.` : "No security key."}
        </p>
        {setup ? (
          <p className="break-all font-mono text-xs" translate="no">
            {setup.secret}
          </p>
        ) : null}
        {recovery.length ? (
          <p className="break-all font-mono text-xs" translate="no">
            {recovery.join(" ")}
          </p>
        ) : null}
        {!status?.totp ? (
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              const code = String(data.get("code") ?? "");
              void run(async () => {
                if (!setup) {
                  setSetup((await secondFactor({ data: { action: "totp-begin" } })) as { secret: string; otpauth: string });
                  return;
                }
                const confirmed = (await secondFactor({ data: { action: "totp-confirm", code } })) as { recoveryCodes: string[] };
                setRecovery(confirmed.recoveryCodes);
                setSetup(null);
                await load();
                onUnlocked?.();
              });
            }}
          >
            {setup ? (
              <input name="code" inputMode="numeric" aria-label="Authenticator code" placeholder="Code" className="h-11 w-32 border border-line bg-transparent px-3 text-sm outline-none" />
            ) : null}
            <button type="submit" disabled={busy} className="inline-flex h-11 items-center border border-line px-3 text-sm hover:border-ink disabled:opacity-60">
              {setup ? "Confirm authenticator" : "Set up authenticator"}
            </button>
          </form>
        ) : (
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              const code = String(new FormData(event.currentTarget).get("code") ?? "");
              void run(async () => {
                await secondFactor({ data: { action: "totp-disable", code } });
                setRecovery([]);
                await load();
              });
            }}
          >
            <input name="code" aria-label="Code to turn off authenticator" placeholder="Code" className="h-11 w-32 border border-line bg-transparent px-3 text-sm outline-none" />
            <button type="submit" disabled={busy} className="inline-flex h-11 items-center border border-line px-3 text-sm hover:border-ink disabled:opacity-60">
              Turn off authenticator
            </button>
          </form>
        )}
        <button
          type="button"
          disabled={busy}
          className="inline-flex h-11 items-center self-start border border-line px-3 text-sm hover:border-ink disabled:opacity-60"
          onClick={() =>
            void run(async () => {
              const options = (await secondFactor({ data: { action: "webauthn-register-options" } })) as {
                challenge: string;
                rpId: string;
                userId: string;
                userName: string;
              };
              const created = await navigator.credentials.create({
                publicKey: {
                  challenge: bytesOf(options.challenge),
                  rp: { name: "Cumulus://Mail", id: options.rpId },
                  user: { id: bytesOf(options.userId), name: options.userName, displayName: options.userName },
                  pubKeyCredParams: [
                    { type: "public-key", alg: -7 },
                    { type: "public-key", alg: -8 },
                  ],
                  timeout: 60_000,
                  attestation: "none",
                  authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
                },
              });
              if (!created || created.type !== "public-key") throw new Error("No security key was created.");
              const credential = created as PublicKeyCredential;
              const attestation = credential.response as AuthenticatorAttestationResponse;
              await secondFactor({
                data: {
                  action: "webauthn-register",
                  name: "Security key",
                  id: credential.id,
                  clientDataJSON: textOf(attestation.clientDataJSON),
                  attestationObject: textOf(attestation.attestationObject),
                },
              });
              await load();
              onUnlocked?.();
            })
          }
        >
          Add security key
        </button>
        {status?.credentials.map((credential) => (
          <div key={credential.id} className="flex items-center justify-between gap-3">
            <p className="truncate text-sm">{credential.name}</p>
            <button
              type="button"
              disabled={busy}
              className="inline-flex h-11 items-center border border-line px-3 text-sm hover:border-ink disabled:opacity-60"
              onClick={() => void run(async () => {
                await secondFactor({ data: { action: "webauthn-remove", id: credential.id } });
                await load();
              })}
            >
              Remove
            </button>
          </div>
        ))}
        {error ? (
          <p role="alert" className="text-xs text-muted">
            {error}
          </p>
        ) : null}
      </dd>
    </div>
  );
}
