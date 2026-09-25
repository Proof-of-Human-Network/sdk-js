/**
 * Unit tests for DAIClient — all public methods.
 * Run: npm test  (builds first, then runs all test files)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { DAIClient, DAIError, generateKeyPair } = await import('../dist/index.js')

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
  return new DAIClient({
    baseUrl: 'http://mock',
    localBaseUrl: 'http://mock',
    localBaseUrl: 'http://mock',
    fetch: makeFetch(responses),
  })
}

// ── scan ──────────────────────────────────────────────────────────────────────

test('scan parses result, brainKey and freeScansLeft', async () => {
  const dai = client([{ body: { result: true, brainKey: 'bk-1', freeScansLeft: 9 } }])
  const res = await dai.scan('0xabc')
  assert.equal(res.result, true)
  assert.equal(res.brainKey, 'bk-1')
  assert.equal(res.freeScansLeft, 9)
})

test('scan returns null result for inconclusive', async () => {
  const dai = client([{ body: { result: null, freeScansLeft: 8 } }])
  const res = await dai.scan('0xabc')
  assert.equal(res.result, null)
})

test('scan propagates DAIError on 4xx', async () => {
  const dai = new DAIClient({
    baseUrl: 'http://mock',
    localBaseUrl: 'http://mock',
    fetch: async () => new Response(
      JSON.stringify({ error: 'forbidden' }),
      { status: 403, headers: { 'Content-Type': 'application/json' } },
    ),
  })
  await assert.rejects(() => dai.scan('0xabc'), (e) => e instanceof DAIError && e.status === 403)
})

// ── scanBulk ──────────────────────────────────────────────────────────────────

test('scanBulk returns jobId and total', async () => {
  const dai = client([{ body: { jobId: 'j-99', status: 'queued', total: 3, pollUrl: '/j/j-99', freeScansLeft: 5 } }])
  const res = await dai.scanBulk(['0xaaa', '0xbbb', '0xccc'])
  assert.equal(res.jobId, 'j-99')
  assert.equal(res.status, 'queued')
  assert.equal(res.total, 3)
})

test('scanBulk throws on empty inputs', async () => {
  await assert.rejects(() => client([]).scanBulk([]), /must not be empty/)
})

// ── getJob ────────────────────────────────────────────────────────────────────

test('getJob parses job snapshot', async () => {
  const dai = client([{ body: {
    jobId: 'j-1', status: 'done', total: 2, done: 2, percent: 100,
    results: [{ input: '0xaaa', result: true }, { input: '0xbbb', result: false }],
    errors: [], createdAt: '2024-01-01T00:00:00Z', completedAt: '2024-01-01T00:01:00Z',
  } }])
  const job = await dai.getJob('j-1')
  assert.equal(job.status, 'done')
  assert.equal(job.percent, 100)
  assert.equal(job.results.length, 2)
  assert.equal(job.results[0].input, '0xaaa')
  assert.equal(job.results[0].result, true)
})

// ── scanAndWait ───────────────────────────────────────────────────────────────

test('scanAndWait submits bulk scan then polls to completion', async () => {
  const dai = client([
    { body: { jobId: 'j-sw', status: 'queued', total: 1, pollUrl: '/j/j-sw', freeScansLeft: 4 } },
    { body: { jobId: 'j-sw', status: 'done', total: 1, done: 1, percent: 100,
      results: [{ input: '0xabc', result: false }], errors: [], createdAt: '', completedAt: '' } },
  ])
  const done = await dai.scanAndWait(['0xabc'], { interval: 5 })
  assert.equal(done.status, 'done')
  assert.equal(done.results.length, 1)
})

// ── getBrainVerdict ───────────────────────────────────────────────────────────

test('getBrainVerdict parses done verdict', async () => {
  const dai = client([{ body: { status: 'done', verdict: 'HUMAN', confidence: 0.91, reasoning: 'active', signals: [] } }])
  const v = await dai.getBrainVerdict('bk-1')
  assert.equal(v.status, 'done')
  assert.equal(v.verdict, 'HUMAN')
  assert.equal(v.confidence, 0.91)
})

test('getBrainVerdict parses pending status', async () => {
  const dai = client([{ body: { status: 'pending' } }])
  const v = await dai.getBrainVerdict('bk-2')
  assert.equal(v.status, 'pending')
})

// ── pollBrainVerdict ──────────────────────────────────────────────────────────

test('pollBrainVerdict polls until status leaves pending', async () => {
  let call = 0
  const snaps = [
    { status: 'pending' },
    { status: 'done', verdict: 'AI', confidence: 0.6 },
  ]
  const dai = new DAIClient({
    baseUrl: 'http://mock',
    localBaseUrl: 'http://mock',
    fetch: async () => new Response(JSON.stringify(snaps[Math.min(call++, snaps.length - 1)]), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }),
  })
  const v = await dai.pollBrainVerdict('bk-1', { interval: 5 })
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
  const dai = new DAIClient({
    baseUrl: 'http://mock',
    localBaseUrl: 'http://mock',
    fetch: async () => new Response(JSON.stringify(responses[Math.min(call++, responses.length - 1)]), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }),
  })
  const sv = await dai.scanAndVerdict('0xabc', {}, { interval: 5 })
  assert.equal(sv.scan.result, true)
  assert.equal(sv.verdict.verdict, 'HUMAN')
})

test('scanAndVerdict returns not_found when scan has no brainKey', async () => {
  const dai = client([{ body: { result: false, freeScansLeft: 2 } }])
  const sv = await dai.scanAndVerdict('0xabc')
  assert.equal(sv.verdict.status, 'not_found')
})

// ── getMethods / getMethod ────────────────────────────────────────────────────

test('getMethods returns array of methods', async () => {
  const dai = client([{ body: [{ id: 'm1', type: 'evm', description: 'ETH balance', score: 1.0, voteCount: 5 }] }])
  const methods = await dai.getMethods()
  assert.equal(methods.length, 1)
  assert.equal(methods[0].id, 'm1')
  assert.equal(methods[0].type, 'evm')
})

test('getMethod returns single method by id', async () => {
  const dai = client([{ body: { id: 'm2', type: 'solana', description: 'SOL staking', score: 2.5, voteCount: 12 } }])
  const m = await dai.getMethod('m2')
  assert.equal(m.id, 'm2')
  assert.equal(m.type, 'solana')
})

// ── getNodeInfo ───────────────────────────────────────────────────────────────

test('getNodeInfo returns node metadata', async () => {
  const dai = client([{ body: { nodeId: 'node-42', version: '1.2.0', walletAddress: 'dai123', reputation: 5, peers: 3 } }])
  const info = await dai.getNodeInfo()
  assert.equal(info.nodeId, 'node-42')
  assert.equal(info.version, '1.2.0')
  assert.equal(info.peers, 3)
})

// ── listSkills ────────────────────────────────────────────────────────────────

test('listSkills returns skill array', async () => {
  const dai = client([{ body: [{ id: 'sk-1', name: 'Summarizer', description: 'Summarise text', triggers: ['summarise'] }] }])
  const skills = await dai.listSkills()
  assert.equal(skills.length, 1)
  assert.equal(skills[0].id, 'sk-1')
})

// ── getMinerInfo ──────────────────────────────────────────────────────────────

test('getMinerInfo returns miner metadata', async () => {
  const dai = client([{ body: { walletAddress: 'dai-miner-1', gasPrice: 1000, model: 'llama-3', queueLength: 2, reputation: 4 } }])
  const info = await dai.getMinerInfo()
  assert.equal(info.walletAddress, 'dai-miner-1')
  assert.equal(info.model, 'llama-3')
})

// ── Wallet / blockchain ───────────────────────────────────────────────────────

test('getBalance returns address and μDAI balance', async () => {
  const dai = client([{ body: { address: 'dai123', balance: 5_000_000_000 } }])
  const bal = await dai.getBalance('dai123')
  assert.equal(bal.address, 'dai123')
  assert.equal(bal.balance, 5_000_000_000)
})

test('getNonce returns current nonce for address', async () => {
  const dai = client([{ body: { address: 'dai123', nonce: 7 } }])
  const n = await dai.getNonce('dai123')
  assert.equal(n.address, 'dai123')
  assert.equal(n.nonce, 7)
})

test('getTransactionHistory returns address and entries', async () => {
  const dai = client([{ body: {
    address: 'dai123',
    entries: [{ height: 100, delta: 1_000_000_000, txHash: 'abc', ts: 1700000000, label: 'transfer' }],
  } }])
  const hist = await dai.getTransactionHistory('dai123')
  assert.equal(hist.address, 'dai123')
  assert.equal(hist.entries.length, 1)
  assert.equal(hist.entries[0].delta, 1_000_000_000)
  assert.equal(hist.entries[0].label, 'transfer')
})

test('getTransactionHistory accepts custom limit', async () => {
  let capturedUrl = ''
  const dai = new DAIClient({
    baseUrl: 'http://mock',
    localBaseUrl: 'http://mock',
    fetch: async (url) => {
      capturedUrl = url
      return new Response(JSON.stringify({ address: 'dai123', entries: [] }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      })
    },
  })
  await dai.getTransactionHistory('dai123', 50)
  assert.ok(capturedUrl.includes('limit=50'))
})

test('getTransactions returns raw tx dict', async () => {
  const dai = client([{ body: { address: 'dai123', transactions: [] } }])
  const txs = await dai.getTransactions('dai123')
  assert.equal(txs.address, 'dai123')
  assert.ok(Array.isArray(txs.transactions))
})

test('getPendingTransactions returns queue', async () => {
  const dai = client([{ body: { pending: [], count: 0 } }])
  const p = await dai.getPendingTransactions()
  assert.equal(p.count, 0)
})

test('submitTransaction posts signed tx and returns txHash', async () => {
  const dai = client([{ body: { txHash: 'cafebabe', status: 'accepted' } }])
  const result = await dai.submitTransaction({
    from: 'daiA', to: 'daiB', amount: 1_000_000_000, fee: 0,
    nonce: 1, timestamp: Date.now(), memo: '',
    txHash: 'cafebabe', signature: 'sig', signingPublicKey: 'pubkey',
  })
  assert.equal(result.txHash, 'cafebabe')
})

test('registerSigningKey posts key and proof', async () => {
  let capturedBody = null
  const dai = new DAIClient({
    baseUrl: 'http://mock',
    localBaseUrl: 'http://mock',
    fetch: async (_url, init) => {
      capturedBody = JSON.parse(init.body)
      return new Response(JSON.stringify({ success: true }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      })
    },
  })
  const res = await dai.registerSigningKey('daiA', 'pubkey-pem', 'proof-b64', 'rotate-b64')
  assert.equal(res.success, true)
  assert.equal(capturedBody.address, 'daiA')
  assert.equal(capturedBody.signingPublicKey, 'pubkey-pem')
  assert.equal(capturedBody.proof, 'proof-b64')
  assert.equal(capturedBody.rotationProof, 'rotate-b64')
})

// ── Natural language jobs ─────────────────────────────────────────────────────

test('submitJob routes to skill then submits job', async () => {
  let call = 0
  const bodies = [
    { type: 'skill', skillId: 'sk-sum', input: { text: 'hello' } },
    { jobId: 'jnl-1', status: 'queued', skillId: 'sk-sum' },
  ]
  const dai = new DAIClient({
    baseUrl: 'http://mock',
    localBaseUrl: 'http://mock',
    fetch: async () => new Response(JSON.stringify(bodies[Math.min(call++, bodies.length - 1)]), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }),
  })
  const ref = await dai.submitJob('Summarise this')
  assert.equal(ref.jobId, 'jnl-1')
})

test('submitJob throws when budget > 0 but no privateKeyPem is given', async () => {
  const dai = client([{ body: { type: 'skill', skillId: 'sk-sum', input: {} } }])
  await assert.rejects(
    () => dai.submitJob('Summarise this', { budget: 0.5, walletAddress: 'daiAlice' }),
    (e) => e instanceof DAIError && e.status === 402,
  )
})

test('submitJob signs a nonce-bound payment proof when budget > 0', async () => {
  const { signingPrivateKey } = await generateKeyPair()
  const bodies = [
    { type: 'skill', skillId: 'sk-sum', input: { text: 'hello' } },
    { minerAddress: 'daiMiner', gasPrice: 1, model: 'qwen2.5:1.5b', queueLength: 0, reputation: 1 },
    { address: 'daiAlice', nonce: 3 },
    { jobId: 'jnl-1', status: 'queued', skillId: 'sk-sum' },
  ]
  let jobBody = null
  let call = 0
  const dai = new DAIClient({
    baseUrl: 'http://mock',
    localBaseUrl: 'http://mock',
    fetch: async (_url, init) => {
      const body = bodies[Math.min(call++, bodies.length - 1)]
      if (init?.body) {
        const parsed = JSON.parse(init.body)
        if (parsed.type === 'skill') jobBody = parsed
      }
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
    },
  })
  const ref = await dai.submitJob('Summarise this', {
    budget: 0.5,
    walletAddress: 'daiAlice',
    privateKeyPem: signingPrivateKey,
  })
  assert.equal(ref.jobId, 'jnl-1')
  assert.equal(jobBody.maxBudget, 500_000_000)
  assert.equal(jobBody.requesterAddress, 'daiAlice')
  assert.ok(jobBody.paymentTx?.txHash)
  assert.ok(jobBody.paymentTx?.signature)
})

test('runCompute throws when budget is not > 0', async () => {
  const { signingPrivateKey } = await generateKeyPair()
  const dai = client([])
  await assert.rejects(
    () => dai.runCompute('hi', { model: 'qwen2.5:1.5b', budget: 0, walletAddress: 'daiAlice', privateKeyPem: signingPrivateKey }),
    (e) => e instanceof DAIError && e.status === 402,
  )
})

test('runCompute signs a payment proof and posts model/dataset to /job', async () => {
  const { signingPrivateKey } = await generateKeyPair()
  const bodies = [
    { minerAddress: 'daiMiner', gasPrice: 1, model: 'qwen2.5:1.5b', queueLength: 0, reputation: 1 },
    { address: 'daiAlice', nonce: 7 },
    { jobId: 'jc-1', status: 'queued' },
  ]
  let jobBody = null
  let call = 0
  const dai = new DAIClient({
    baseUrl: 'http://mock',
    localBaseUrl: 'http://mock',
    fetch: async (_url, init) => {
      const body = bodies[Math.min(call++, bodies.length - 1)]
      if (init?.body) {
        const parsed = JSON.parse(init.body)
        if (parsed.type === 'compute') jobBody = parsed
      }
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
    },
  })
  const ref = await dai.runCompute('Summarize the top rows', {
    model: 'llama3.1:8b',
    dataset: 'some-org/some-dataset',
    budget: 0.5,
    walletAddress: 'daiAlice',
    privateKeyPem: signingPrivateKey,
  })
  assert.equal(ref.jobId, 'jc-1')
  assert.equal(jobBody.model, 'llama3.1:8b')
  assert.equal(jobBody.dataset, 'some-org/some-dataset')
  assert.equal(jobBody.maxBudget, 500_000_000)
  assert.equal(jobBody.payload.prompt, 'Summarize the top rows')
  assert.ok(jobBody.paymentTx?.txHash)
  assert.ok(jobBody.paymentTx?.signature)
})

test('chat posts message + attachments to /chat/ask', async () => {
  let posted = null
  const dai = new DAIClient({
    baseUrl: 'http://mock',
    localBaseUrl: 'http://mock',
    fetch: async (_url, init) => {
      posted = JSON.parse(init.body)
      return new Response(JSON.stringify({
        type: 'chat', message: 'ok', cascade: true, tasks: true,
        jobs: [{ id: 'skill:web_search', kind: 'skill', ok: true }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    },
  })
  const r = await dai.chat('weather and image', {
    attachments: [{ name: 'a.txt', content: 'hello' }],
    private: true,
  })
  assert.equal(posted.message, 'weather and image')
  assert.equal(posted.attachments[0].name, 'a.txt')
  assert.equal(r.message, 'ok')
  assert.equal(r.cascade, true)
  assert.equal(r.tasks, true)
})

test('chat surfaces 412 dataset required with body on DAIError', async () => {
  const dai = new DAIClient({
    baseUrl: 'http://mock',
    localBaseUrl: 'http://mock',
    fetch: async () => new Response(JSON.stringify({
      error: 'dataset needed',
      code: 'HF_DATASET_DOWNLOAD_REQUIRED',
      datasetId: 'dair-ai/emotion',
    }), { status: 412, headers: { 'Content-Type': 'application/json' } }),
  })
  await assert.rejects(
    () => dai.chat('use emotion dataset please'),
    (e) => e instanceof DAIError && e.status === 412
      && e.body?.code === 'HF_DATASET_DOWNLOAD_REQUIRED'
      && e.body?.datasetId === 'dair-ai/emotion',
  )
})

test('runCompute forwards attachments on payload', async () => {
  const { signingPrivateKey } = await generateKeyPair()
  const bodies = [
    { minerAddress: 'daiMiner', gasPrice: 1, model: 'qwen3-1.7b', queueLength: 0, reputation: 1 },
    { address: 'daiAlice', nonce: 1 },
    { jobId: 'jc-att', status: 'queued' },
  ]
  let jobBody = null
  let call = 0
  const dai = new DAIClient({
    baseUrl: 'http://mock',
    localBaseUrl: 'http://mock',
    fetch: async (_url, init) => {
      const body = bodies[Math.min(call++, bodies.length - 1)]
      if (init?.body) {
        const parsed = JSON.parse(init.body)
        if (parsed.type === 'compute') jobBody = parsed
      }
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
    },
  })
  await dai.runCompute('describe this', {
    model: 'qwen3vl-2b',
    budget: 0.1,
    walletAddress: 'daiAlice',
    privateKeyPem: signingPrivateKey,
    attachments: [{ name: 'dot.png', dataUrl: 'data:image/png;base64,aaa' }],
  })
  assert.equal(jobBody.payload.attachments[0].name, 'dot.png')
})

test('listDatasets / getMcpStatus hit the right endpoints', async () => {
  const urls = []
  const dai = new DAIClient({
    baseUrl: 'http://mock',
    localBaseUrl: 'http://mock',
    fetch: async (url) => {
      urls.push(url)
      if (url.includes('/api/hf-dataset')) {
        return new Response(JSON.stringify({ datasets: [{ id: 'dair-ai/emotion' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify({ servers: [], tools: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    },
  })
  const ds = await dai.listDatasets()
  assert.equal(ds.datasets[0].id, 'dair-ai/emotion')
  await dai.getMcpStatus()
  assert.ok(urls.some(u => u.endsWith('/api/hf-dataset')))
  assert.ok(urls.some(u => u.endsWith('/api/mcp/status')))
})

test('submitJob throws when no skill matches route', async () => {
  const dai = client([{ body: { type: 'chat', reason: 'No skill matched the question' } }])
  await assert.rejects(
    () => dai.submitJob('random question'),
    (e) => e instanceof DAIError && e.status === 422,
  )
})

test('getJobStatus returns status for NL job', async () => {
  const dai = client([{ body: { jobId: 'jnl-1', status: 'computing' } }])
  const s = await dai.getJobStatus('jnl-1')
  assert.equal(s.jobId, 'jnl-1')
  assert.equal(s.status, 'computing')
})

test('getJobResult parses completed NL job result', async () => {
  const dai = client([{ body: {
    jobId: 'jnl-1',
    profile: { skillOutput: { text: 'Summary here' }, skillId: 'sk-sum', tokensUsed: 42, nlResponse: 'Here is a summary.' },
  } }])
  const r = await dai.getJobResult('jnl-1')
  assert.equal(r.jobId, 'jnl-1')
  assert.equal(r.status, 'done')
  assert.equal(r.nlResponse, 'Here is a summary.')
  assert.equal(r.tokensUsed, 42)
  assert.equal(r.skillId, 'sk-sum')
})

test('getJobResult returns computing status on HTTP 202', async () => {
  const dai = new DAIClient({
    baseUrl: 'http://mock',
    localBaseUrl: 'http://mock',
    fetch: async () => new Response('', { status: 202, headers: { 'Content-Type': 'application/json' } }),
  })
  const r = await dai.getJobResult('jnl-1')
  assert.equal(r.status, 'computing')
  assert.equal(r.output, null)
})

test('pollJobResult polls status then fetches result when done', async () => {
  let call = 0
  const responses = [
    { jobId: 'jnl-1', status: 'done' },
    { jobId: 'jnl-1', profile: { nlResponse: 'Done!', skillId: 'sk', tokensUsed: 10, skillOutput: null } },
  ]
  const dai = new DAIClient({
    baseUrl: 'http://mock',
    localBaseUrl: 'http://mock',
    fetch: async () => new Response(JSON.stringify(responses[Math.min(call++, responses.length - 1)]), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }),
  })
  const r = await dai.pollJobResult('jnl-1', { interval: 5 })
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
  const dai = new DAIClient({
    baseUrl: 'http://mock',
    localBaseUrl: 'http://mock',
    fetch: async () => new Response(JSON.stringify(responses[Math.min(call++, responses.length - 1)]), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }),
  })
  const r = await dai.askAndWait('What is 2+2?', { interval: 5 })
  assert.equal(r.nlResponse, 'Answer')
})

// ── activeNode ────────────────────────────────────────────────────────────────

test('activeNode returns baseUrl immediately when set', () => {
  const dai = new DAIClient({
    baseUrl: 'https://api.example.com',
    fetch: async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
  })
  assert.equal(dai.activeNode, 'https://api.example.com')
})

// ── estimate ──────────────────────────────────────────────────────────────────

const ESTIMATE_BODY = {
  ok: true, type: 'compute', target: 'job', model: 'qwen3-1.7b', currency: 'DAI', gasPrice: 1,
  route: { mode: 'direct', predicted: true, reason: 'chat' },
  tokens: { prompt: { min: 19, max: 19 }, output: { min: 1, max: 512 }, skillCompute: { min: 0, max: 0 }, total: { min: 20, max: 531 } },
  calls: [], breakdown: [],
  fees: { currency: 'DAI', minimum: { tokens: 990, raw: 990, currency: 'DAI', gate: '/job' }, recommended: { tokens: 990, raw: 990, currency: 'DAI' } },
  outputCap: { budgetCapApplies: true, tokens: 512 }, warnings: [],
}

test('estimate POSTs the job fields to /api/estimate and returns the typed result', async () => {
  let seen
  const dai = new DAIClient({
    baseUrl: 'http://mock',
    fetch: async (url, init) => {
      seen = { url, init }
      return new Response(JSON.stringify(ESTIMATE_BODY), { status: 200, headers: { 'Content-Type': 'application/json' } })
    },
  })
  const res = await dai.estimate({ prompt: 'Hello', skillId: 'web_search', maxOutputTokens: 200 })
  assert.equal(seen.url, 'http://mock/api/estimate')
  assert.equal(seen.init.method, 'POST')
  const sent = JSON.parse(seen.init.body)
  assert.equal(sent.prompt, 'Hello')
  assert.equal(sent.skillId, 'web_search')
  assert.equal(sent.maxOutputTokens, 200)
  assert.equal(res.fees.recommended.raw, 990)
  assert.equal(res.tokens.total.max, 531)
})

test('estimate works against a remote node (read-only, no localBaseUrl needed)', async () => {
  const dai = new DAIClient({ baseUrl: 'https://remote.example', fetch: makeFetch([ESTIMATE_BODY]) })
  const res = await dai.estimate({ prompt: 'x' })
  assert.equal(res.ok, true)
})

test('estimate defaults requesterAddress to the client wallet and lets a call override it', async () => {
  const bodies = []
  const dai = new DAIClient({
    baseUrl: 'http://mock', walletAddress: 'dai' + 'a'.repeat(40),
    fetch: async (_u, init) => { bodies.push(JSON.parse(init.body)); return new Response(JSON.stringify(ESTIMATE_BODY)) },
  })
  await dai.estimate({ prompt: 'x' })
  await dai.estimate({ prompt: 'x', requesterAddress: 'dai' + 'b'.repeat(40) })
  assert.equal(bodies[0].requesterAddress, 'dai' + 'a'.repeat(40))
  assert.equal(bodies[1].requesterAddress, 'dai' + 'b'.repeat(40))
})

test('estimate rejects an empty request locally, but allows a skill job with no question', async () => {
  const dai = client([ESTIMATE_BODY])
  await assert.rejects(() => dai.estimate({}), (e) => e instanceof DAIError && e.status === 400)
  const res = await dai.estimate({ type: 'skill', skillId: 'web_search' })
  assert.equal(res.ok, true)
})

test('estimate surfaces node errors as DAIError (e.g. 404 on a node without the endpoint)', async () => {
  const dai = client([{ status: 404, body: { error: 'Not found' } }])
  await assert.rejects(() => dai.estimate({ prompt: 'x' }), (e) => e instanceof DAIError && e.status === 404)
  const bad = client([{ status: 422, body: { error: 'Dataset "x" is not installed', code: 'dataset_not_installed' } }])
  await assert.rejects(() => bad.estimate({ prompt: 'x', dataset: 'x' }), (e) => e.status === 422 && e.body.code === 'dataset_not_installed')
})
