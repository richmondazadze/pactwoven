import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { canonicalJson } from '../../../../packages/contracts/src/canonical';
import { NativeGoogleBindingSchema, NativeGoogleEnvelopeSchema, NativeGoogleError, type NativeGoogleBinding, type NativeGoogleEnvelope } from '../../../../packages/contracts/src/native-google';

export interface ProtectedGoogleKeyring { activeKeyId: string; getKey(keyId: string): Uint8Array | undefined }
/** Only an injected protected keyring. No environment discovery, generated key,
 * plaintext fallback, serialized keyring, logging or public DTO. */
export class GoogleCredentialVault {
  constructor(private readonly keys: ProtectedGoogleKeyring) {
    if (!keys || !/^[A-Za-z0-9_-]{1,128}$/.test(keys.activeKeyId) || keys.getKey(keys.activeKeyId)?.byteLength !== 32) throw new NativeGoogleError('GOOGLE_INTEGRATION_REQUIRED');
  }
  private aad(binding: NativeGoogleBinding, purpose: 'oauth_pkce'|'oauth_tokens', keyId: string): Buffer {
    return Buffer.from(canonicalJson({ namespace: 'pactwoven/private-google/v1', algorithm: 'A256GCM', purpose, keyId, binding: NativeGoogleBindingSchema.parse(binding) }));
  }
  seal(value: unknown, binding: NativeGoogleBinding, purpose: 'oauth_pkce'|'oauth_tokens'): NativeGoogleEnvelope {
    const keyId = this.keys.activeKeyId, key = this.keys.getKey(keyId);
    if (!key || key.byteLength !== 32) throw new NativeGoogleError('GOOGLE_INTEGRATION_REQUIRED');
    const plaintext = Buffer.from(canonicalJson(value));
    if (plaintext.length > 32768) throw new NativeGoogleError('GOOGLE_DENIED');
    try {
      const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce);
      cipher.setAAD(this.aad(binding, purpose, keyId));
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      return NativeGoogleEnvelopeSchema.parse({ schemaVersion: 1, algorithm: 'A256GCM', keyId, nonce: nonce.toString('base64url'), ciphertext: ciphertext.toString('base64url'), tag: cipher.getAuthTag().toString('base64url') });
    } finally { plaintext.fill(0); }
  }
  open(input: NativeGoogleEnvelope, binding: NativeGoogleBinding, purpose: 'oauth_pkce'|'oauth_tokens'): unknown {
    let plaintext: Buffer | undefined;
    try {
      const envelope = NativeGoogleEnvelopeSchema.parse(input), key = this.keys.getKey(envelope.keyId);
      if (!key || key.byteLength !== 32) throw Error();
      const nonce = Buffer.from(envelope.nonce, 'base64url'), tag = Buffer.from(envelope.tag, 'base64url'), ciphertext = Buffer.from(envelope.ciphertext, 'base64url');
      if (nonce.toString('base64url') !== envelope.nonce || tag.toString('base64url') !== envelope.tag || ciphertext.toString('base64url') !== envelope.ciphertext) throw Error();
      const decipher = createDecipheriv('aes-256-gcm', key, nonce); decipher.setAAD(this.aad(binding, purpose, envelope.keyId)); decipher.setAuthTag(tag);
      plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return JSON.parse(plaintext.toString('utf8'));
    } catch { throw new NativeGoogleError('GOOGLE_DENIED'); }
    finally { plaintext?.fill(0); }
  }
}
