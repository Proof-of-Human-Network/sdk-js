/**
 * Live integration test — exercises POHClient methods against a running local node.
 *
 * Usage:
 *   BASE_URL=http://127.0.0.1:3456 node --test tests/live-all-methods.test.js
 */
import { test, describe, before } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const {
  POHClient,
  deriveAddressFromSigningKey,
  createSigningProof,
  buildTransfer,
  signTransaction,
} = await import('../dist/index.js')

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3456'

function loadWallet() {
  const addr = process.env.WALLET_ADDRESS || 'poh6ca521c53e9d2eda7add15d15f0bb49f2f401cb7'
  let pem = process.env.SIGNING_PRIVATE_KEY
  const path = join(homedir(), '.poh-miner', 'wallets', `${addr}.json`)
  const w = JSON.parse(readFileSync(path, 'utf8'))
  if (!pem) pem = w.signingPrivateKey
  return { address: addr, signingPrivateKey: pem.replace(/\\n/g, '\n'), signingPublicKey: w.signingPublicKey }
}

const wallet = loadWallet()
const poh = new POHClient({
  baseUrl: BASE_URL,
  localBaseUrl: BASE_URL,
  walletAddress: wallet.address,
})

let recipient = null
let nlJobId = null

before(async () => {
  const res = await fetch(`${BASE_URL}/healthz`)
  assert.ok(res.ok, `miner not reachable at ${BASE_URL}`)
  recipient = (await poh.getMinerInfo()).minerAddress
  assert.ok(recipient?.startsWith('poh'))
})

describe('node info', () => {
  test('getNodeInfo', async () => {
    const info = await poh.getNodeInfo()
    assert.equal(info.status, 'ok')
  })

  test('getMinerInfo', async () => {
    const info = await poh.getMinerInfo()
    assert.ok(info.minerAddress?.startsWith('poh'))
    assert.ok(typeof info.gasPrice === 'number')
  })

  test('listSkills', async () => {
    const skills = await poh.listSkills()
    assert.ok(Array.isArray(skills))
    assert.ok(skills.length > 0)
  })
})

describe('wallet reads', () => {
  test('getBalance', async () => {
    const { balance } = await poh.getBalance(wallet.address)
    assert.ok(balance > 0)
  })

  test('getNonce', async () => {
    const { nonce, pendingNonce } = await poh.getNonce(wallet.address)
    assert.ok(typeof nonce === 'number' && nonce >= 0)
    assert.ok(pendingNonce == null || pendingNonce >= nonce)
  })

  test('getTransactionHistory', async () => {
    const hist = await poh.getTransactionHistory(wallet.address, 5)
    assert.equal(hist.address, wallet.address)
  })

  test('getTransactions', async () => {
    const tx = await poh.getTransactions(wallet.address)
    assert.equal(tx.address, wallet.address)
    assert.ok(Array.isArray(tx.transactions))
  })

  test('getPendingTransactions', async () => {
    const pending = await poh.getPendingTransactions()
    assert.ok(Array.isArray(pending.txs) || Array.isArray(pending.pending) || pending.count != null)
  })
})

describe('signing utilities', () => {
  test('deriveAddressFromSigningKey is deterministic', async () => {
    const derived = await deriveAddressFromSigningKey(wallet.signingPublicKey)
    assert.ok(derived.startsWith('poh'))
    assert.equal(derived, await deriveAddressFromSigningKey(wallet.signingPublicKey))
  })

  test('createSigningProof', async () => {
    const proof = await createSigningProof(wallet.address, wallet.signingPrivateKey)
    assert.ok(proof.length > 10)
  })
})

describe('methods (local /methods endpoint)', () => {
  test('fetch methods via raw API', async () => {
    const res = await fetch(`${BASE_URL}/methods`)
    assert.ok(res.ok)
    const methods = await res.json()
    assert.ok(Array.isArray(methods) && methods.length > 0)
    assert.ok(typeof methods[0].id === 'string' || typeof methods[0].description === 'string')
  })
})

describe('chat', () => {
  test('returns a message', { timeout: 120_000 }, async () => {
    const res = await poh.chat('Reply with exactly: pong', { private: true })
    assert.ok(typeof res.message === 'string' && res.message.length > 0)
  })
})

describe('transactions', () => {
  test('transfer micro amount', async () => {
    const before = await poh.getNonce(wallet.address)
    const nextNonce = (before.pendingNonce ?? before.nonce) + 1
    const { txHash } = await poh.transfer(
      wallet.address,
      recipient,
      0.000001,
      wallet.signingPrivateKey,
    )
    assert.ok(txHash)
    const after = await poh.getNonce(wallet.address)
    assert.ok((after.pendingNonce ?? after.nonce) >= nextNonce - 1)
  })

  test('buildTransfer + signTransaction + submitTransaction', async () => {
    const { nonce, pendingNonce } = await poh.getNonce(wallet.address)
    const next = (pendingNonce ?? nonce) + 1
    const tx = await buildTransfer(wallet.address, recipient, 0.000001, next)
    const signed = await signTransaction(tx, wallet.signingPrivateKey)
    const { txHash } = await poh.submitTransaction(signed)
    assert.ok(txHash)
  })
})

describe('runCompute + job polling', () => {
  test('submits paid compute job and polls result', { timeout: 180_000 }, async () => {
    const ref = await poh.runCompute('Say hello in one word.', {
      model: 'mixtral:latest',
      budget: 0.001,
      walletAddress: wallet.address,
      privateKeyPem: wallet.signingPrivateKey,
    })
    nlJobId = ref.jobId
    assert.ok(nlJobId)
    const status = await poh.getJobStatus(nlJobId)
    assert.ok(status.status)
    const result = await poh.pollJobResult(nlJobId, { interval: 2000, timeout: 150_000 })
    assert.ok(['done', 'error', 'computing'].includes(result.status))
    if (result.status === 'done') {
      const raw = await poh.getJobResult(nlJobId)
      assert.equal(raw.jobId, nlJobId)
    }
  })
})

describe('submitFeedback', () => {
  test('rates completed job when available', async () => {
    if (!nlJobId) return
    const status = await poh.getJobStatus(nlJobId)
    if (status.status !== 'done') return
    const fb = await poh.submitFeedback(nlJobId, 4, 'sdk live test')
    assert.ok(fb.ok === true || fb.success === true || fb.stars === 4)
  })
})