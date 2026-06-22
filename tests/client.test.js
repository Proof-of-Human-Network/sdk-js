/**
 * Unit tests for POHClient — all public methods.
 * Run: npm test  (builds first, then runs all test files)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { POHClient, POHError } = await import('../dist/index.js')

// ── Mock helpers ──────────────────────────────────────────────────────────────

function makeFetch(responses) {
  let i = 0
  return async () => {
    const r = responses[Math.min(i++, responses.length - 1)]
    const body = r.body !== undefined ? r.body : r
    return new Response(JSON.stringify(body), {
      status: r.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
}

function client(responses) {
  return new POHClient({ baseUrl: 'http://mock', fetch: makeFetch(responses) })
}

// ── scan ──────────────────────────────────────────────────────────────────────

test('scan parses result, brainKey and freeScansLeft', async () => {
  const poh = client([{ body: { result: true, brainKey: 'bk-1', freeScansLeft: 9 } }])
  const res = await poh.scan('0xabc')
  assert.equal(res.result, true)
  assert.equal(res.brainKey, 'bk-1')
  assert.equal(res.freeScansLeft, 9)
})

test('scan returns null result for inconclusive', async () => {
  const poh = client([{ body: { result: null, freeScansLeft: 8 } }])
  const res = await poh.scan('0xabc')
  assert.equal(res.result, null)
})

test('scan propagates POHError on 4xx', async () => {
  const poh = new POHClient({
    baseUrl: 'http://mock',
    fetch: async () => new Response(
      JSON.stringify({ error: 'forbidden' }),
      { status: 403, headers: { 'Content-Type': 'application/json' } },
    ),
  })
  await assert.rejects(() => poh.scan('0xabc'), (e) => e instanceof POHError && e.status === 403)
})

// ── scanBulk ──────────────────────────────────────────────────────────────────

test('scanBulk returns jobId and total', async () => {
  const poh = client([{ body: { jobId: 'j-99', status: 'queued', total: 3, pollUrl: '/j/j-99', freeScansLeft: 5 } }])
  const res = await poh.scanBulk(['0xaaa', '0xbbb', '0xccc'])
  assert.equal(res.jobId, 'j-99')
  assert.equal(res.status, 'queued')
  assert.equal(res.total, 3)
})

test('scanBulk throws on empty inputs', async () => {
  await assert.rejects(() => client([]).scanBulk([]), /must not be empty/)
})

// ── getJob ────────────────────────────────────────────────────────────────────

test('getJob parses job snapshot', async () => {
  const poh = client([{ body: {
    jobId: 'j-1', status: 'done', total: 2, done: 2, percent: 100,
    results: [{ input: '0xaaa', result: true }, { input: '0xbbb', result: false }],
    errors: [], createdAt: '2024-01-01T00:00:00Z', completedAt: '2024-01-01T00:01:00Z',
  } }])
  const job = await poh.getJob('j-1')
  assert.equal(job.status, 'done')
  assert.equal(job.percent, 100)
  assert.equal(job.results.length, 2)
  assert.equal(job.results[0].input, '0xaaa')
  assert.equal(job.results[0].result, true)
})

// ── scanAndWait ───────────────────────────────────────────────────────────────

test('scanAndWait submits bulk scan then polls to completion', async () => {
  const poh = client([
    { body: { jobId: 'j-sw', status: 'queued', total: 1, pollUrl: '/j/j-sw', freeScansLeft: 4 } },
    { body: { jobId: 'j-sw', status: 'done', total: 1, done: 1, percent: 100,
      results: [{ input: '0xabc', result: false }], errors: [], createdAt: '', completedAt: '' } },
  ])
  const done = await poh.scanAndWait(['0xabc'], { interval: 5 })
  assert.equal(done.status, 'done')
  assert.equal(done.results.length, 1)
})

// ── getBrainVerdict ───────────────────────────────────────────────────────────

test('getBrainVerdict parses done verdict', async () => {
  const poh = client([{ body: { status: 'done', verdict: 'HUMAN', confidence: 0.91, reasoning: 'active', signals: [] } }])
  const v = await poh.getBrainVerdict('bk-1')
  assert.equal(v.status, 'done')
  assert.equal(v.verdict, 'HUMAN')
  assert.equal(v.confidence, 0.91)
})

test('getBrainVerdict parses pending status', async () => {
  const poh = client([{ body: { status: 'pending' } }])
  const v = await poh.getBrainVerdict('bk-2')
  assert.equal(v.status, 'pending')
})

// ── pollBrainVerdict ──────────────────────────────────────────────────────────

test('pollBrainVerdict polls until status leaves pending', async () => {
  let call = 0
  const snaps = [
    { status: 'pending' },
    { status: 'done', verdict: 'AI', confidence: 0.6 },
  ]
  const poh = new POHClient({
    baseUrl: 'http://mock',
    fetch: async () => new Response(JSON.stringify(snaps[Math.min(call++, snaps.length - 1)]), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }),
  })
  const v = await poh.pollBrainVerdict('bk-1', { interval: 5 })
  assert.equal(v.status, 'done')
  assert.equal(v.verdict, 'AI')
})

// ── scanAndVerdict ────────────────────────────────────────────────────────────

test('scanAndVerdict returns scan + resolved verdict', async () => {
  let call = 0
  const responses = [
    { result: true, brainKey: 'bk-x', freeScansLeft: 3 },
    { status: 'done', verdict: 'HUMAN', confidence: 0.95 },
  ]
  const poh = new POHClient({
    baseUrl: 'http://mock',
    fetch: async () => new Response(JSON.stringify(responses[Math.min(call++, responses.length - 1)]), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }),
  })
  const sv = await poh.scanAndVerdict('0xabc', {}, { interval: 5 })
  assert.equal(sv.scan.result, true)
  assert.equal(sv.verdict.verdict, 'HUMAN')
})

test('scanAndVerdict returns not_found when scan has no brainKey', async () => {
  const poh = client([{ body: { result: false, freeScansLeft: 2 } }])
  const sv = await poh.scanAndVerdict('0xabc')
  assert.equal(sv.verdict.status, 'not_found')
})

// ── getMethods / getMethod ────────────────────────────────────────────────────

test('getMethods returns array of methods', async () => {
  const poh = client([{ body: [{ id: 'm1', type: 'evm', description: 'ETH balance', score: 1.0, voteCount: 5 }] }])
  const methods = await poh.getMethods()
  assert.equal(methods.length, 1)
  assert.equal(methods[0].id, 'm1')
  assert.equal(methods[0].type, 'evm')
})

test('getMethod returns single method by id', async () => {
  const poh = client([{ body: { id: 'm2', type: 'solana', description: 'SOL staking', score: 2.5, voteCount: 12 } }])
  const m = await poh.getMethod('m2')
  assert.equal(m.id, 'm2')
  assert.equal(m.type, 'solana')
})

// ── getNodeInfo ───────────────────────────────────────────────────────────────

test('getNodeInfo returns node metadata', async () => {
  const poh = client([{ body: { nodeId: 'node-42', version: '1.2.0', walletAddress: 'poh123', reputation: 5, peers: 3 } }])
  const info = await poh.getNodeInfo()
  assert.equal(info.nodeId, 'node-42')
  assert.equal(info.version, '1.2.0')
  assert.equal(info.peers, 3)
})

// ── listSkills ────────────────────────────────────────────────────────────────

test('listSkills returns skill array', async () => {
  const poh = client([{ body: [{ id: 'sk-1', name: 'Summarizer', description: 'Summarise text', triggers: ['summarise'] }] }])
  const skills = await poh.listSkills()
  assert.equal(skills.length, 1)
  assert.equal(skills[0].id, 'sk-1')
})

// ── getMinerInfo ──────────────────────────────────────────────────────────────

test('getMinerInfo returns miner metadata', async () => {
  const poh = client([{ body: { walletAddress: 'poh-miner-1', gasPrice: 1000, model: 'llama-3', queueLength: 2, reputation: 4 } }])
  const info = await poh.getMinerInfo()
  assert.equal(info.walletAddress, 'poh-miner-1')
  assert.equal(info.model, 'llama-3')
})

// ── Wallet / blockchain ───────────────────────────────────────────────────────

test('getBalance returns address and μPOH balance', async () => {
  const poh = client([{ body: { address: 'poh123', balance: 5_000_000_000 } }])
  const bal = await poh.getBalance('poh123')
  assert.equal(bal.address, 'poh123')
  assert.equal(bal.balance, 5_000_000_000)
})

test('getNonce returns current nonce for address', async () => {
  const poh = client([{ body: { address: 'poh123', nonce: 7 } }])
  const n = await poh.getNonce('poh123')
  assert.equal(n.address, 'poh123')
  assert.equal(n.nonce, 7)
})

test('getTransactionHistory returns address and entries', async () => {
  const poh = client([{ body: {
    address: 'poh123',
    entries: [{ height: 100, delta: 1_000_000_000, txHash: 'abc', ts: 1700000000, label: 'transfer' }],
  } }])
  const hist = await poh.getTransactionHistory('poh123')
  assert.equal(hist.address, 'poh123')
  assert.equal(hist.entries.length, 1)
  assert.equal(hist.entries[0].delta, 1_000_000_000)
  assert.equal(hist.entries[0].label, 'transfer')
})

test('getTransactionHistory accepts custom limit', async () => {
  let capturedUrl = ''
  const poh = new POHClient({
    baseUrl: 'http://mock',
    fetch: async (url) => {
      capturedUrl = url
      return new Response(JSON.stringify({ address: 'poh123', entries: [] }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      })
    },
  })
  await poh.getTransactionHistory('poh123', 50)
  assert.ok(capturedUrl.includes('limit=50'))
})

test('getTransactions returns raw tx dict', async () => {
  const poh = client([{ body: { address: 'poh123', transactions: [] } }])
  const txs = await poh.getTransactions('poh123')
  assert.equal(txs.address, 'poh123')
  assert.ok(Array.isArray(txs.transactions))
})

test('getPendingTransactions returns queue', async () => {
  const poh = client([{ body: { pending: [], count: 0 } }])
  const p = await poh.getPendingTransactions()
  assert.equal(p.count, 0)
})

test('submitTransaction posts signed tx and returns txHash', async () => {
  const poh = client([{ body: { txHash: 'cafebabe', status: 'accepted' } }])
  const result = await poh.submitTransaction({
    from: 'pohA', to: 'pohB', amount: 1_000_000_000, fee: 0,
    nonce: 1, timestamp: Date.now(), memo: '',
    txHash: 'cafebabe', signature: 'sig', signingPublicKey: 'pubkey',
  })
  assert.equal(result.txHash, 'cafebabe')
})

test('registerSigningKey posts key and proof', async () => {
  let capturedBody = null
  const poh = new POHClient({
    baseUrl: 'http://mock',
    fetch: async (_url, init) => {
      capturedBody = JSON.parse(init.body)
      return new Response(JSON.stringify({ success: true }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      })
    },
  })
  const res = await poh.registerSigningKey('pohA', 'pubkey-pem', 'proof-b64')
  assert.equal(res.success, true)
  assert.equal(capturedBody.address, 'pohA')
  assert.equal(capturedBody.signingPublicKey, 'pubkey-pem')
  assert.equal(capturedBody.proof, 'proof-b64')
})

// ── Natural language jobs ─────────────────────────────────────────────────────

test('submitJob routes to skill then submits job', async () => {
  let call = 0
  const bodies = [
    { type: 'skill', skillId: 'sk-sum', input: { text: 'hello' } },
    { jobId: 'jnl-1', status: 'queued', skillId: 'sk-sum' },
  ]
  const poh = new POHClient({
    baseUrl: 'http://mock',
    fetch: async () => new Response(JSON.stringify(bodies[Math.min(call++, bodies.length - 1)]), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }),
  })
  const ref = await poh.submitJob('Summarise this')
  assert.equal(ref.jobId, 'jnl-1')
})

test('submitJob throws when no skill matches route', async () => {
  const poh = client([{ body: { type: 'chat', reason: 'No skill matched the question' } }])
  await assert.rejects(
    () => poh.submitJob('random question'),
    (e) => e instanceof POHError && e.status === 422,
  )
})

test('getJobStatus returns status for NL job', async () => {
  const poh = client([{ body: { jobId: 'jnl-1', status: 'computing' } }])
  const s = await poh.getJobStatus('jnl-1')
  assert.equal(s.jobId, 'jnl-1')
  assert.equal(s.status, 'computing')
})

test('getJobResult parses completed NL job result', async () => {
  const poh = client([{ body: {
    jobId: 'jnl-1',
    profile: { skillOutput: { text: 'Summary here' }, skillId: 'sk-sum', tokensUsed: 42, nlResponse: 'Here is a summary.' },
  } }])
  const r = await poh.getJobResult('jnl-1')
  assert.equal(r.jobId, 'jnl-1')
  assert.equal(r.status, 'done')
  assert.equal(r.nlResponse, 'Here is a summary.')
  assert.equal(r.tokensUsed, 42)
  assert.equal(r.skillId, 'sk-sum')
})

test('getJobResult returns computing status on HTTP 202', async () => {
  const poh = new POHClient({
    baseUrl: 'http://mock',
    fetch: async () => new Response('', { status: 202, headers: { 'Content-Type': 'application/json' } }),
  })
  const r = await poh.getJobResult('jnl-1')
  assert.equal(r.status, 'computing')
  assert.equal(r.output, null)
})

test('pollJobResult polls status then fetches result when done', async () => {
  let call = 0
  const responses = [
    { jobId: 'jnl-1', status: 'done' },
    { jobId: 'jnl-1', profile: { nlResponse: 'Done!', skillId: 'sk', tokensUsed: 10, skillOutput: null } },
  ]
  const poh = new POHClient({
    baseUrl: 'http://mock',
    fetch: async () => new Response(JSON.stringify(responses[Math.min(call++, responses.length - 1)]), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }),
  })
  const r = await poh.pollJobResult('jnl-1', { interval: 5 })
  assert.equal(r.nlResponse, 'Done!')
})

test('askAndWait routes, submits and polls to completion', async () => {
  let call = 0
  const responses = [
    { type: 'skill', skillId: 'sk-1', input: {} },
    { jobId: 'jnl-2', status: 'queued', skillId: 'sk-1' },
    { jobId: 'jnl-2', status: 'done' },
    { jobId: 'jnl-2', profile: { nlResponse: 'Answer', skillId: 'sk-1', tokensUsed: 5, skillOutput: null } },
  ]
  const poh = new POHClient({
    baseUrl: 'http://mock',
    fetch: async () => new Response(JSON.stringify(responses[Math.min(call++, responses.length - 1)]), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }),
  })
  const r = await poh.askAndWait('What is 2+2?', { interval: 5 })
  assert.equal(r.nlResponse, 'Answer')
})

// ── activeNode ────────────────────────────────────────────────────────────────

test('activeNode returns baseUrl immediately when set', () => {
  const poh = new POHClient({
    baseUrl: 'https://api.example.com',
    fetch: async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
  })
  assert.equal(poh.activeNode, 'https://api.example.com')
})
