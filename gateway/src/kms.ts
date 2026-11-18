/**
 * Optional AWS KMS envelope encryption for upstream pool keys (KEY_POOL_KMS_KEY_ID).
 *
 * A 256-bit data key is generated once with KMS GenerateDataKey; only its KMS-encrypted form is stored
 * (in the pool document, next to the sealed keys). At startup the gateway asks KMS to decrypt it and
 * keeps the plaintext data key in memory only. Stored keys are then sealed with AES-256-GCM under that
 * data key. Revoking the task role's kms:Decrypt permission makes every stored key unreadable at once,
 * and every unseal is attributable in CloudTrail.
 *
 * Switching an existing pool from KEY_POOL_SECRET to KMS (or back) re-encrypts the stored keys
 * automatically, as long as the old secret is still configured at the first start.
 */
import { DecryptCommand, GenerateDataKeyCommand, KMSClient } from "@aws-sdk/client-kms";

export interface KmsLike {
  generateDataKey(keyId: string): Promise<{ plaintext: Uint8Array; ciphertext: Uint8Array }>;
  decrypt(keyId: string, ciphertext: Uint8Array): Promise<Uint8Array>;
}

const CONTEXT = { purpose: "tokener-keypool" };

export function sdkKms(region: string): KmsLike {
  const c = new KMSClient({ region });
  return {
    async generateDataKey(keyId) {
      const r = await c.send(new GenerateDataKeyCommand({ KeyId: keyId, KeySpec: "AES_256", EncryptionContext: CONTEXT }));
      if (!r.Plaintext || !r.CiphertextBlob) throw new Error("KMS GenerateDataKey returned no key");
      return { plaintext: r.Plaintext, ciphertext: r.CiphertextBlob };
    },
    async decrypt(keyId, ciphertext) {
      const r = await c.send(new DecryptCommand({ KeyId: keyId, CiphertextBlob: ciphertext, EncryptionContext: CONTEXT }));
      if (!r.Plaintext) throw new Error("KMS Decrypt returned no plaintext");
      return r.Plaintext;
    },
  };
}

/**
 * Resolve the pool's data key: decrypt the stored one, or create it on first use.
 * Returns the plaintext key plus the (possibly new) wrapped key to persist.
 */
export async function resolveDataKey(kms: KmsLike, keyId: string, wrapped: string | undefined): Promise<{ key: Buffer; wrapped: string; created: boolean }> {
  if (wrapped) {
    const plain = await kms.decrypt(keyId, Buffer.from(wrapped, "base64"));
    return { key: Buffer.from(plain), wrapped, created: false };
  }
  const g = await kms.generateDataKey(keyId);
  return { key: Buffer.from(g.plaintext), wrapped: Buffer.from(g.ciphertext).toString("base64"), created: true };
}
