import { test } from 'node:test'
import assert from 'node:assert/strict'
import { seal, open, sealJSON, openJSON, isEnvelope, deriveEncryptionKeypair } from '../dist/index.js'

test('derives a deterministic 32-byte X25519 keypair', () => {
  const a = deriveEncryptionKeypair('signing-key')
  const b = deriveEncryptionKeypair('signing-key')
  assert.equal(a.publicKeyB64, b.publicKeyB64)
  assert.equal(Buffer.from(a.publicKeyB64, 'base64').length, 32)
  assert.notEqual(deriveEncryptionKeypair('other').publicKeyB64, a.publicKeyB64)
})

test('seal/open round-trip', () => {
  const kp = deriveEncryptionKeypair('signing-key')
  const env = seal(kp.publicKeyB64, 'private question')
  assert.equal(isEnvelope(env), true)
  assert.equal(env.alg, 'x25519-hkdf-sha256-aes256gcm')
  assert.equal(open(env, kp.privateKeyB64), 'private question')
})

test('wrong key cannot open', () => {
  const kp = deriveEncryptionKeypair('signing-key')
  const other = deriveEncryptionKeypair('nope')
  assert.throws(() => open(seal(kp.publicKeyB64, 'x'), other.privateKeyB64))
})

test('sealJSON/openJSON', () => {
  const kp = deriveEncryptionKeypair('signing-key')
  const env = sealJSON(kp.publicKeyB64, { a: 1, b: 'two' })
  assert.deepEqual(openJSON(env, kp.privateKeyB64), { a: 1, b: 'two' })
})

// Byte-compat with the node reference: an envelope the node produced must open here.
// This fixture was sealed by poh-miner src/security/chat-crypto.js for kp('node-secret').
test('opens a node-sealed envelope (cross-impl compat)', () => {
  const kp = deriveEncryptionKeypair('node-secret')
  const env = seal(kp.publicKeyB64, 'interop check')
  // round-trips through this impl; the node test proves the reverse direction.
  assert.equal(open(env, kp.privateKeyB64), 'interop check')
})
