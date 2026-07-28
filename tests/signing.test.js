/**
 * Unit tests for signing utilities.
 * All functions use Web Crypto (Node.js 18+) — no network required.
 * Run: npm test
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const {
  generateKeyPair,
  deriveAddressFromSigningKey,
  signData,
  createSigningProof,
  createRotationProof,
  buildTransfer,
  signTransaction,
  computeTxHash,
  computeJobPaymentHash,
  pemToBytes,
  bytesToPem,
} = await import('../dist/index.js')

// ── PEM helpers ───────────────────────────────────────────────────────────────

test('pemToBytes / bytesToPem round-trip', () => {
  const original = new Uint8Array([1, 2, 3, 4, 5, 32])
  const pem = bytesToPem(original, 'PUBLIC KEY')
  assert.ok(pem.startsWith('-----BEGIN PUBLIC KEY-----'))
  assert.ok(pem.endsWith('-----END PUBLIC KEY-----\n'))
  const restored = pemToBytes(pem)
  assert.deepEqual(restored, original)
})

// ── generateKeyPair ───────────────────────────────────────────────────────────

test('generateKeyPair returns valid PEM keys and derived address', async () => {
  const kp = await generateKeyPair()
  assert.ok(kp.signingPrivateKey.includes('-----BEGIN PRIVATE KEY-----'))
  assert.ok(kp.signingPublicKey.includes('-----BEGIN PUBLIC KEY-----'))
  assert.match(kp.address, /^poh[a-f0-9]{40}$/)
  assert.equal(kp.address, await deriveAddressFromSigningKey(kp.signingPublicKey))
})

test('generateKeyPair produces different keys each call', async () => {
  const kp1 = await generateKeyPair()
  const kp2 = await generateKeyPair()
  assert.notEqual(kp1.signingPrivateKey, kp2.signingPrivateKey)
  assert.notEqual(kp1.signingPublicKey, kp2.signingPublicKey)
})

// ── signData / createSigningProof ─────────────────────────────────────────────

test('signData returns base64 string', async () => {
  const { signingPrivateKey } = await generateKeyPair()
  const sig = await signData('hello world', signingPrivateKey)
  assert.ok(typeof sig === 'string')
  // Ed25519 signature = 64 bytes → base64 = 88 chars
  assert.equal(sig.length, 88)
})

test('signData produces different signatures for different messages', async () => {
  const { signingPrivateKey } = await generateKeyPair()
  const sig1 = await signData('message-A', signingPrivateKey)
  const sig2 = await signData('message-B', signingPrivateKey)
  assert.notEqual(sig1, sig2)
})

test('signData produces same signature for same input (deterministic)', async () => {
  const { signingPrivateKey } = await generateKeyPair()
  const sig1 = await signData('deterministic', signingPrivateKey)
  const sig2 = await signData('deterministic', signingPrivateKey)
  assert.equal(sig1, sig2)
})

test('createSigningProof returns same result as signData of address', async () => {
  const { signingPrivateKey } = await generateKeyPair()
  const address = 'poh_test_address'
  const proof = await createSigningProof(address, signingPrivateKey)
  const direct = await signData(address, signingPrivateKey)
  assert.equal(proof, direct)
})

// ── computeTxHash ─────────────────────────────────────────────────────────────

test('computeTxHash returns 64-char hex string', async () => {
  const hash = await computeTxHash({
    from: 'pohA', to: 'pohB', amount: 1_000_000_000, fee: 0, nonce: 1, timestamp: 1700000000000, memo: '',
  })
  assert.equal(typeof hash, 'string')
  assert.equal(hash.length, 64)
  assert.ok(/^[0-9a-f]+$/.test(hash))
})

test('computeTxHash is deterministic for same inputs', async () => {
  const args = { from: 'pohA', to: 'pohB', amount: 5_000_000_000, fee: 1000, nonce: 3, timestamp: 1700000000000, memo: 'test' }
  const h1 = await computeTxHash(args)
  const h2 = await computeTxHash(args)
  assert.equal(h1, h2)
})

test('computeTxHash differs for different amounts', async () => {
  const base = { from: 'pohA', to: 'pohB', fee: 0, nonce: 1, timestamp: 1700000000000, memo: '' }
  const h1 = await computeTxHash({ ...base, amount: 1_000_000_000 })
  const h2 = await computeTxHash({ ...base, amount: 2_000_000_000 })
  assert.notEqual(h1, h2)
})

// ── buildTransfer ─────────────────────────────────────────────────────────────

test('buildTransfer converts POH to μPOH', async () => {
  const tx = await buildTransfer('pohA', 'pohB', 1.5, 3)
  assert.equal(tx.amount, 1_500_000_000)
})

test('buildTransfer sets all required fields', async () => {
  const tx = await buildTransfer('pohA', 'pohB', 0.001, 5, 100, 'memo text')
  assert.equal(tx.from, 'pohA')
  assert.equal(tx.to, 'pohB')
  assert.equal(tx.amount, 1_000_000)
  assert.equal(tx.fee, 100)
  assert.equal(tx.nonce, 5)
  assert.equal(tx.memo, 'memo text')
  assert.ok(typeof tx.timestamp === 'number')
  assert.ok(typeof tx.txHash === 'string' && tx.txHash.length === 64)
})

test('buildTransfer txHash is correct SHA-256', async () => {
  const tx = await buildTransfer('pohA', 'pohB', 1.0, 1)
  const expectedHash = await computeTxHash(tx)
  assert.equal(tx.txHash, expectedHash)
})

// ── signTransaction ───────────────────────────────────────────────────────────

test('signTransaction fills in signature and signingPublicKey', async () => {
  const { signingPrivateKey } = await generateKeyPair()
  const tx = await buildTransfer('pohA', 'pohB', 2.0, 1)
  const signed = await signTransaction(tx, signingPrivateKey)
  assert.ok(typeof signed.signature === 'string' && signed.signature.length > 0)
  assert.ok(signed.signingPublicKey?.includes('-----BEGIN PUBLIC KEY-----'))
  assert.equal(signed.txHash, tx.txHash)
})

test('signTransaction throws if txHash is missing', async () => {
  const { signingPrivateKey } = await generateKeyPair()
  const tx = { from: 'pohA', to: 'pohB', amount: 1_000_000_000, fee: 0, nonce: 1, timestamp: Date.now(), memo: '' }
  await assert.rejects(() => signTransaction(tx, signingPrivateKey), /txHash missing/)
})

test('signTransaction preserves from, to, amount, nonce, memo', async () => {
  const { signingPrivateKey } = await generateKeyPair()
  const tx = await buildTransfer('pohA', 'pohB', 3.0, 7, 500, 'hello')
  const signed = await signTransaction(tx, signingPrivateKey)
  assert.equal(signed.from, tx.from)
  assert.equal(signed.to, tx.to)
  assert.equal(signed.amount, tx.amount)
  assert.equal(signed.nonce, tx.nonce)
  assert.equal(signed.memo, tx.memo)
})

// ── Multi-currency (stablecoins) ─────────────────────────────────────────────

test('POH tx hash omits currency — byte-identical to the legacy preimage', async () => {
  const fields = { from: 'pohA', to: 'pohB', amount: 1000, fee: 5, nonce: 1, timestamp: 1700000000000, memo: '' }
  const legacyPayload = JSON.stringify({
    from: fields.from, to: fields.to, amount: fields.amount,
    fee: fields.fee, nonce: fields.nonce, timestamp: fields.timestamp, memo: fields.memo,
  })
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(legacyPayload))
  const legacyHash = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
  assert.equal(await computeTxHash(fields), legacyHash)
  assert.equal(await computeTxHash({ ...fields, currency: 'POH' }), legacyHash) // POH normalizes away
})

test('buildTransfer with a stablecoin scales at 2 decimals and carries currency', async () => {
  const tx = await buildTransfer('pohA', 'pohB', 12.5, 1, 0, '', 'aiGEL')
  assert.equal(tx.amount, 1250)          // 12.50 aiGEL → 1250 raw (×100)
  assert.equal(tx.currency, 'aiGEL')
  // currency changes the hash vs the same POH-shaped tx
  const pohTx = await buildTransfer('pohA', 'pohB', 12.5, 1)
  assert.notEqual(tx.txHash, pohTx.txHash)
})

test('computeJobPaymentHash: currency is the 6th key only when non-POH', async () => {
  const base = { jobId: 'j1', requesterAddress: 'pohA', minerAddress: 'pohM', amount: 100, nonce: 0 }
  const pohHash = await computeJobPaymentHash(base)
  assert.equal(await computeJobPaymentHash({ ...base, currency: 'POH' }), pohHash)
  const gelHash = await computeJobPaymentHash({ ...base, currency: 'aiGEL' })
  assert.notEqual(gelHash, pohHash)
})
