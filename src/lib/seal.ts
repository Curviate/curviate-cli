/**
 * The client half of the sealed-key wire format used by `curviate setup`.
 *
 * ECDH-P256 → HKDF-SHA256 → AES-256-GCM. The service seals the delivered API
 * key to the ephemeral public key this process generates per run; this is the
 * production unsealer that has to agree with it.
 *
 * ## Why this is its own file
 *
 * A change to the HKDF `info` string, the derived key length, the P-256 point
 * encoding, the IV length or the ciphertext-then-tag order breaks setup for
 * every user while both sides' own tests stay green. So the service side runs
 * a round-trip against THIS module directly, which means the file may carry
 * `node:crypto` and nothing else — no `citty`, no SDK, no config I/O — so it
 * stays importable from a checkout that never installed these dependencies.
 *
 * `commands/setup.ts` re-exports everything here, so the extraction is
 * behaviour-neutral for every existing caller.
 */

import { createDecipheriv, createECDH, hkdfSync, randomBytes } from "node:crypto";

/** Bytes of session-id entropy. 18 bytes is 144 bits. */
const SESSION_ID_BYTES = 18;

export const HKDF_INFO = "curviate-cli-setup-v1";
export const SEAL_ALG = "ECDH-P256-HKDF-SHA256-A256GCM";
const GCM_TAG_BYTES = 16;

export interface SessionMaterial {
  sessionId: string;
  /** Raw uncompressed P-256 point, base64url. */
  publicKey: string;
  /** The private scalar, base64url. Never displayed, never transmitted. */
  privateKey: string;
}

export function generateSessionMaterial(): SessionMaterial {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return {
    sessionId: randomBytes(SESSION_ID_BYTES).toString("base64url"),
    publicKey: ecdh.getPublicKey().toString("base64url"),
    privateKey: ecdh.getPrivateKey().toString("base64url"),
  };
}

/** The sealed-key object the exchange returns. */
export interface SealedKey {
  alg: string;
  epk: string;
  iv: string;
  ciphertext: string;
}

/**
 * Recover the API key from the sealed response.
 *
 * ECDH against the server's ephemeral point, HKDF-SHA256 to an AES-256 key,
 * AES-GCM open with no additional data. The authentication tag is the last
 * 16 bytes of `ciphertext`.
 */
export function unsealApiKey(sealed: SealedKey, privateKey: string): string {
  if (sealed.alg !== SEAL_ALG) {
    throw new Error(`Unsupported sealing algorithm "${sealed.alg}".`);
  }
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(Buffer.from(privateKey, "base64url"));
  const shared = ecdh.computeSecret(Buffer.from(sealed.epk, "base64url"));
  const key = Buffer.from(
    hkdfSync("sha256", shared, Buffer.alloc(0), Buffer.from(HKDF_INFO, "utf8"), 32),
  );
  const blob = Buffer.from(sealed.ciphertext, "base64url");
  if (blob.length <= GCM_TAG_BYTES) throw new Error("Sealed payload is truncated.");
  const body = blob.subarray(0, blob.length - GCM_TAG_BYTES);
  const tag = blob.subarray(blob.length - GCM_TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.iv, "base64url"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
}
