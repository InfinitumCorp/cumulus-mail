type OpenPgp = typeof import("openpgp");

async function lib(): Promise<OpenPgp> {
  return import("openpgp");
}

export function isArmored(body: string): boolean {
  return body.includes("-----BEGIN PGP MESSAGE-----");
}

export async function generateMailKey(
  name: string,
  email: string,
  passphrase: string,
): Promise<{ publicKey: string; privateKey: string }> {
  const openpgp = await lib();
  const generated = await openpgp.generateKey({
    userIDs: [{ name, email }],
    passphrase,
  });
  return { publicKey: generated.publicKey, privateKey: generated.privateKey };
}

/** Encrypt on the caller. The private key is not sent anywhere by this function. */
export async function encryptFor(body: string, publicKeys: string[]): Promise<string> {
  if (!publicKeys.length) throw new Error("No OpenPGP key for this recipient.");
  const openpgp = await lib();
  const encryptionKeys = await Promise.all(publicKeys.map((armoredKey) => openpgp.readKey({ armoredKey })));
  const message = await openpgp.createMessage({ text: body });
  const encrypted = await openpgp.encrypt({ message, encryptionKeys });
  if (typeof encrypted !== "string") throw new Error("OpenPGP encryption did not return text.");
  return encrypted;
}

export async function decryptWith(armored: string, privateKeyArmored: string, passphrase: string): Promise<string> {
  const openpgp = await lib();
  const privateKey = await openpgp.decryptKey({
    privateKey: await openpgp.readPrivateKey({ armoredKey: privateKeyArmored }),
    passphrase,
  });
  const message = await openpgp.readMessage({ armoredMessage: armored });
  const decrypted = await openpgp.decrypt({ message, decryptionKeys: privateKey });
  return typeof decrypted.data === "string" ? decrypted.data : new TextDecoder().decode(decrypted.data);
}
