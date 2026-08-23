/**
 * Live integration test — exercises DAIClient methods against a running local node.
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
  DAIClient,
  deriveAddressFromSigningKey,
  createSigningProof,
  buildTransfer,
  signTransaction,
} = await import('../dist/index.js')

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3456'

function loadWallet() {
  const addr = process.env.WALLET_ADDRESS || 'dai6ca521c53e9d2eda7add15d15f0bb49f2f401cb7'
  let pem = process.env.SIGNING_PRIVATE_KEY
  const path = join(homedir(), '.dai-miner', 'wallets', `${addr}.json`)
  const w = JSON.parse(readFileSync(path, 'utf8'))
  if (!pem) pem = w.signingPrivateKey
  return { address: addr, signingPrivateKey: pem.replace(/\\n/g, '\n'), signingPublicKey: w.signingPublicKey }
}

const wallet = loadWallet()
const dai = new DAIClient({
  baseUrl: BASE_URL,
  localBaseUrl: BASE_URL,
  walletAddress: wallet.address,
})

let recipient = null
let nlJobId = null

before(async () => {
  const res = await fetch(`${BASE_URL}/healthz`)
  assert.ok(res.ok, `miner not reachable at ${BASE_URL}`)
  recipient = (await dai.getMinerInfo()).minerAddress
  assert.ok(recipient?.startsWith('dai'))
})

describe('node info', () => {
  test('getNodeInfo', async () => {
    const info = await dai.getNodeInfo()
    assert.equal(info.status, 'ok')
  })

  test('getMinerInfo', async () => {
    const info = await dai.getMinerInfo()
    assert.ok(info.minerAddress?.startsWith('dai'))
    assert.ok(typeof info.gasPrice === 'number')
  })

  test('listSkills', async () => {
    const skills = await dai.listSkills()
    assert.ok(Array.isArray(skills))
    assert.ok(skills.length > 0)
  })
})

describe('wallet reads', () => {
  test('getBalance', async () => {
    const { balance } = await dai.getBalance(wallet.address)
    assert.ok(balance > 0)
  })

  test('getNonce', async () => {
    const { nonce, pendingNonce } = await dai.getNonce(wallet.address)
    assert.ok(typeof nonce === 'number' && nonce >= 0)
    assert.ok(pendingNonce == null || pendingNonce >= nonce)
  })

  test('getTransactionHistory', async () => {
    const hist = await dai.getTransactionHistory(wallet.address, 5)
    assert.equal(hist.address, wallet.address)
  })

  test('getTransactions', async () => {
    const tx = await dai.getTransactions(wallet.address)
    assert.equal(tx.address, wallet.address)
    assert.ok(Array.isArray(tx.transactions))
  })

  test('getPendingTransactions', async () => {
    const pending = await dai.getPendingTransactions()
    assert.ok(Array.isArray(pending.txs) || Array.isArray(pending.pending) || pending.count != null)
  })
})

describe('signing utilities', () => {
  test('deriveAddressFromSigningKey is deterministic', async () => {
    const derived = await deriveAddressFromSigningKey(wallet.signingPublicKey)
    assert.ok(derived.startsWith('dai'))
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
    const res = await dai.chat('Reply with exactly: pong', { private: true })
    assert.ok(typeof res.message === 'string' && res.message.length > 0)
  })
})

describe('transactions', () => {
  test('transfer micro amount', async () => {
    const before = await dai.getNonce(wallet.address)
    const nextNonce = (before.pendingNonce ?? before.nonce) + 1
    const { txHash } = await dai.transfer(
      wallet.address,
      recipient,
      0.000001,
      wallet.signingPrivateKey,
    )
    assert.ok(txHash)
    const after = await dai.getNonce(wallet.address)
    assert.ok((after.pendingNonce ?? after.nonce) >= nextNonce - 1)
  })

  test('buildTransfer + signTransaction + submitTransaction', async () => {
    const { nonce, pendingNonce } = await dai.getNonce(wallet.address)
    const next = (pendingNonce ?? nonce) + 1
    const tx = await buildTransfer(wallet.address, recipient, 0.000001, next)
    const signed = await signTransaction(tx, wallet.signingPrivateKey)
    const { txHash } = await dai.submitTransaction(signed)
    assert.ok(txHash)
  })
})

describe('runCompute + job polling', () => {
  test('submits paid compute job and polls result', { timeout: 180_000 }, async () => {
    const ref = await dai.runCompute('Say hello in one word.', {
      model: 'mixtral:latest',
      budget: 0.001,
      walletAddress: wallet.address,
      privateKeyPem: wallet.signingPrivateKey,
    })
    nlJobId = ref.jobId
    assert.ok(nlJobId)
    const status = await dai.getJobStatus(nlJobId)
    assert.ok(status.status)
    const result = await dai.pollJobResult(nlJobId, { interval: 2000, timeout: 150_000 })
    assert.ok(['done', 'error', 'computing'].includes(result.status))
    if (result.status === 'done') {
      const raw = await dai.getJobResult(nlJobId)
      assert.equal(raw.jobId, nlJobId)
    }
  })
})

describe('submitFeedback', () => {
  test('rates completed job when available', async () => {
    if (!nlJobId) return
    const status = await dai.getJobStatus(nlJobId)
    if (status.status !== 'done') return
    const fb = await dai.submitFeedback(nlJobId, 4, 'sdk live test')
    assert.ok(fb.ok === true || fb.success === true || fb.stars === 4)
  })
})