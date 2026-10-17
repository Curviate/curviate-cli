import { createCipheriv, createECDH, hkdfSync, randomBytes } from "node:crypto";

/** Seal `plaintext` to the CLI's public key exactly as the server does (an independent build of the ciphertext). */
export function seal(plaintext: string, cliPublicKeyB64: string) {
  const ephemeral = createECDH("prime256v1");
  ephemeral.generateKeys();
  const shared = ephemeral.computeSecret(Buffer.from(cliPublicKeyB64, "base64url"));
  const key = Buffer.from(hkdfSync("sha256", shared, Buffer.alloc(0), Buffer.from("curviate-cli-setup-v1", "utf8"), 32));
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    alg: "ECDH-P256-HKDF-SHA256-A256GCM",
    epk: ephemeral.getPublicKey().toString("base64url"),
    iv: iv.toString("base64url"),
    ciphertext: Buffer.concat([body, cipher.getAuthTag()]).toString("base64url"),
  };
}
