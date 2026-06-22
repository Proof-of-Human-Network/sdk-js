/**
 * PoH signing and transaction utilities.
 *
 * Key format: Ed25519 PEM (PKCS8 private / SPKI public), matching the PoH node.
 *
 * Runtime requirements:
 *   - Node.js 18+ (Web Crypto API with Ed25519 support)
 *   - Modern browsers (Chrome 100+, Firefox 105+, Safari 16.4+)
 *   - Deno 1.x
 */

// ── PEM helpers ───────────────────────────────────────────────────────────────

function b64decode(b64: string): Uint8Array {
  // Works in both browsers and Node.js 18+
  const bin = atob(b64)
  const arr = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
  return arr
}

function b64encode(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}

/** Strip PEM headers and decode the base64 body to bytes. */
export function pemToBytes(pem: string): Uint8Array {
  const b64 = pem.replace(/-----[A-Z ]+-----/g, '').replace(/\s/g, '')
  return b64decode(b64)
}

/** Encode raw bytes to PEM with the given type header. */
export function bytesToPem(bytes: Uint8Array, type: 'PRIVATE KEY' | 'PUBLIC KEY'): string {
  const b64   = b64encode(bytes)
  const lines = b64.match(/.{1,64}/g)?.join('\n') ?? b64
  return `-----BEGIN ${type}-----\n${lines}\n-----END ${type}-----\n`
}

// ── Key generation ────────────────────────────────────────────────────────────

export interface KeyPair {
  /** Ed25519 private key in PKCS8 PEM format. Keep secret. */
  signingPrivateKey: string
  /** Ed25519 public key in SPKI PEM format. Share with the node via registerSigningKey(). */
  signingPublicKey: string
}

/**
 * Generate a fresh Ed25519 signing keypair.
 *
 * The returned PEM keys are compatible with the PoH node and with
 * `signData()` / `signTransaction()`.
 *
 * @example
 * const { signingPrivateKey, signingPublicKey } = await generateKeyPair()
 */
export async function generateKeyPair(): Promise<KeyPair> {
  const kp = await crypto.subtle.generateKey(
    { name: 'Ed25519' } as EcKeyGenParams,
    true,
    ['sign', 'verify'],
  )
  const privBuf = await crypto.subtle.exportKey('pkcs8', kp.privateKey as CryptoKey)
  const pubBuf  = await crypto.subtle.exportKey('spki',  kp.publicKey  as CryptoKey)
  return {
    signingPrivateKey: bytesToPem(new Uint8Array(privBuf), 'PRIVATE KEY'),
    signingPublicKey:  bytesToPem(new Uint8Array(pubBuf),  'PUBLIC KEY'),
  }
}

// ── Signing ───────────────────────────────────────────────────────────────────

async function importPrivKey(pem: string): Promise<CryptoKey> {
  const bytes: ArrayBuffer = pemToBytes(pem).buffer as ArrayBuffer
  return crypto.subtle.importKey(
    'pkcs8',
    bytes,
    { name: 'Ed25519' } as EcKeyImportParams,
    true,
    ['sign'],
  )
}

/**
 * Sign an arbitrary UTF-8 message with an Ed25519 private key (PKCS8 PEM).
 * Returns a base64-encoded signature, matching `Wallet.sign()` on the PoH node.
 */
export async function signData(message: string, privateKeyPem: string): Promise<string> {
  const key = await importPrivKey(privateKeyPem)
  const sig  = await crypto.subtle.sign(
    { name: 'Ed25519' } as AlgorithmIdentifier,
    key,
    new TextEncoder().encode(message),
  )
  return b64encode(new Uint8Array(sig))
}

/**
 * Build the proof needed by `registerSigningKey()` / `/api/wallet/register-key`.
 *
 * The proof is a signature of the wallet address itself, proving you own
 * the private key corresponding to the public key you are registering.
 */
export async function createSigningProof(walletAddress: string, privateKeyPem: string): Promise<string> {
  return signData(walletAddress, privateKeyPem)
}

// ── Transaction ───────────────────────────────────────────────────────────────

export interface PohTx {
  from:      string
  to:        string
  /** Amount in μPOH (1 POH = 1 000 000 000 μPOH). */
  amount:    number
  fee:       number
  nonce:     number
  timestamp: number
  memo:      string
  txHash?:   string
  signature?:        string
  signingPublicKey?: string
}

/** Compute the SHA-256 transaction hash over canonical fields. */
export async function computeTxHash(
  tx: Pick<PohTx, 'from' | 'to' | 'amount' | 'fee' | 'nonce' | 'timestamp' | 'memo'>,
): Promise<string> {
  const payload = JSON.stringify({
    from: tx.from, to: tx.to, amount: tx.amount,
    fee: tx.fee, nonce: tx.nonce, timestamp: tx.timestamp, memo: tx.memo,
  })
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload))
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Build an unsigned PoH transfer transaction.
 *
 * @param from       Sender address (`poh...`).
 * @param to         Recipient address.
 * @param amountPOH  Amount in POH units (e.g. 1.5 → 1 500 000 000 μPOH).
 * @param nonce      Sender's current nonce + 1. Fetch via `client.getNonce(address)`.
 * @param fee        Miner fee in μPOH (default 0).
 * @param memo       Optional memo string.
 *
 * @example
 * const { nonce } = await poh.getNonce(myAddress)
 * const tx = await buildTransfer(myAddress, recipient, 5.0, nonce + 1)
 */
export async function buildTransfer(
  from: string,
  to: string,
  amountPOH: number,
  nonce: number,
  fee = 0,
  memo = '',
): Promise<PohTx> {
  const base = { from, to, amount: Math.round(amountPOH * 1_000_000_000), fee, nonce, timestamp: Date.now(), memo }
  return { ...base, txHash: await computeTxHash(base) }
}

/**
 * Sign a transaction returned by `buildTransfer()`.
 *
 * @example
 * const tx     = await buildTransfer(from, to, 5.0, nonce + 1)
 * const signed = await signTransaction(tx, myPrivateKeyPem)
 * const result = await poh.submitTransaction(signed)
 */
export async function signTransaction(tx: PohTx, privateKeyPem: string): Promise<PohTx> {
  if (!tx.txHash) throw new Error('tx.txHash missing — call buildTransfer() first')
  const signature = await signData(tx.txHash, privateKeyPem)
  // Derive the public key: export private key as JWK (contains 'x' = public key bytes),
  // then reconstruct a public-only CryptoKey and export as SPKI PEM.
  const privKey = await importPrivKey(privateKeyPem)
  const jwk = await crypto.subtle.exportKey('jwk', privKey) as JsonWebKey & { x?: string }
  const pubKey = await crypto.subtle.importKey(
    'jwk',
    { kty: 'OKP', crv: 'Ed25519', x: jwk.x, key_ops: ['verify'] } as JsonWebKey,
    { name: 'Ed25519' } as EcKeyImportParams,
    true,
    ['verify'],
  )
  const pubBuf = await crypto.subtle.exportKey('spki', pubKey)
  const signingPublicKey = bytesToPem(new Uint8Array(pubBuf), 'PUBLIC KEY')
  return { ...tx, signature, signingPublicKey }
}
