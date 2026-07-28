/**
 * chat-crypto — portable public-job chat encryption for the POH SDK.
 *
 * Public compute jobs are raced by miners the requester doesn't control, so the
 * on-chain record of the prompt/reply is sealed to the requester's X25519 key:
 *
 *     X25519 (ECDH) → HKDF-SHA256 → AES-256-GCM
 *
 * Byte-identical to the node reference (poh-miner `src/security/chat-crypto.js`,
 * verified round-trip). Implemented with @noble (pure JS) so it behaves the same in
 * Node, browsers and React Native. See CHAT-CRYPTO.md for the wire format.
 */
import { x25519 } from '@noble/curves/ed25519.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { randomBytes } from '@noble/hashes/utils.js'
import { gcm } from '@noble/ciphers/aes.js'

const SEAL_INFO = new TextEncoder().encode('poh-chat-seal-v1')
const SCALAR_INFO = new TextEncoder().encode('poh-x25519-v1')

export interface SealedEnvelope {
  v: 1
  alg: 'x25519-hkdf-sha256-aes256gcm'
  epk: string // base64 raw 32-byte ephemeral public key
  iv: string // base64 12-byte IV
  ct: string // base64 (ciphertext ‖ 16-byte GCM tag)
}

// Base64 without depending on Node's Buffer types (SDK targets browsers/RN too).
const _Buffer = (globalThis as { Buffer?: { from(a: unknown, enc?: string): Uint8Array & { toString(enc: string): string } } }).Buffer
function b64e(u: Uint8Array): string {
  if (_Buffer) return _Buffer.from(u).toString('base64')
  let s = ''
  for (const b of u) s += String.fromCharCode(b)
  return btoa(s)
}
function b64d(s: string): Uint8Array {
  if (_Buffer) return new Uint8Array(_Buffer.from(s, 'base64'))
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
}
const utf8 = (s: string) => new TextEncoder().encode(s)
const fromUtf8 = (u: Uint8Array) => new TextDecoder().decode(u)

/**
 * Deterministically derive the wallet's X25519 encryption keypair from a stable
 * secret (its ed25519 signing private key PEM), matching the node. The public key is
 * what you register via {@link POHClient.registerKeyPair}; the private scalar opens
 * sealed replies.
 */
export function deriveEncryptionKeypair(stableSecret: string | Uint8Array): {
  publicKeyB64: string
  privateKeyB64: string
} {
  const ikm = typeof stableSecret === 'string' ? utf8(stableSecret) : stableSecret
  const scalar = hkdf(sha256, ikm, new Uint8Array(0), SCALAR_INFO, 32)
  return { publicKeyB64: b64e(x25519.getPublicKey(scalar)), privateKeyB64: b64e(scalar) }
}

function deriveKey(shared: Uint8Array, recipientPub: Uint8Array, epk: Uint8Array): Uint8Array {
  const salt = new Uint8Array(recipientPub.length + epk.length)
  salt.set(recipientPub, 0)
  salt.set(epk, recipientPub.length)
  return hkdf(sha256, shared, salt, SEAL_INFO, 32)
}

/** Seal a plaintext to a recipient's raw X25519 public key (base64). */
export function seal(recipientPubB64: string, plaintext: string | Uint8Array): SealedEnvelope {
  const recipientPub = b64d(recipientPubB64)
  if (recipientPub.length !== 32) throw new Error('recipient X25519 pubkey must be 32 bytes')
  const esk = x25519.utils.randomSecretKey()
  const epk = x25519.getPublicKey(esk)
  const shared = x25519.getSharedSecret(esk, recipientPub)
  const key = deriveKey(shared, recipientPub, epk)
  const iv = randomBytes(12)
  const pt = typeof plaintext === 'string' ? utf8(plaintext) : plaintext
  const ct = gcm(key, iv).encrypt(pt)
  return { v: 1, alg: 'x25519-hkdf-sha256-aes256gcm', epk: b64e(epk), iv: b64e(iv), ct: b64e(ct) }
}

/** Open an envelope with the recipient's raw X25519 private scalar (base64). */
export function open(env: SealedEnvelope, privateScalarB64: string): string {
  if (!env || env.v !== 1) throw new Error('unsupported chat-crypto envelope')
  const scalar = b64d(privateScalarB64)
  const recipientPub = x25519.getPublicKey(scalar)
  const epk = b64d(env.epk)
  const shared = x25519.getSharedSecret(scalar, epk)
  const key = deriveKey(shared, recipientPub, epk)
  return fromUtf8(gcm(key, b64d(env.iv)).decrypt(b64d(env.ct)))
}

export function sealJSON(recipientPubB64: string, obj: unknown): SealedEnvelope {
  return seal(recipientPubB64, JSON.stringify(obj))
}
export function openJSON<T = unknown>(env: SealedEnvelope, privateScalarB64: string): T {
  return JSON.parse(open(env, privateScalarB64)) as T
}

/** True if `x` looks like a chat-crypto envelope (vs cleartext). */
export function isEnvelope(x: unknown): x is SealedEnvelope {
  return (
    !!x &&
    typeof x === 'object' &&
    (x as SealedEnvelope).v === 1 &&
    typeof (x as SealedEnvelope).epk === 'string' &&
    typeof (x as SealedEnvelope).ct === 'string'
  )
}
