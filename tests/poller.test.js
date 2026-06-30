// Unit tests for the polling utilities
// Run: node --test tests/poller.test.js
import { test } from 'node:test'
import assert   from 'node:assert/strict'

// Import from built dist so tests validate the actual published output
// Run `npm run build` before running tests.
const { POHClient, POHError } = await import('../dist/index.js')

// ── pollUntilDone via POHClient.pollJob ────────────────────────────────────

test('pollJob resolves when job reaches done', async () => {
  let calls = 0
  const snapshots = [
    { jobId: 'j1', status: 'processing', total: 2, done: 1, percent: 50, results: [], errors: [], createdAt: '' },
    { jobId: 'j1', status: 'done',       total: 2, done: 2, percent: 100, results: [
      { input: '0xaaa', result: true },
      { input: '0xbbb', result: false },
    ], errors: [], createdAt: '', completedAt: new Date().toISOString() },
  ]

  const client = new POHClient({
    baseUrl: 'http://mock',
    fetch: async (url) => {
      const snap = snapshots[Math.min(calls++, snapshots.length - 1)]
      return new Response(JSON.stringify(snap), { status: 200, headers: { 'Content-Type': 'application/json' } })
    },
  })

  const result = await client.pollJob('j1', { interval: 10 })
  assert.equal(result.status, 'done')
  assert.equal(result.percent, 100)
  assert.equal(calls, 2)
})

test('pollJob stops on error status', async () => {
  const client = new POHClient({
    baseUrl: 'http://mock',
    fetch: async () => new Response(
      JSON.stringify({ jobId: 'j2', status: 'error', total: 1, done: 0, percent: 0, results: [], errors: ['something failed'], createdAt: '' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ),
  })

  const result = await client.pollJob('j2', { interval: 10 })
  assert.equal(result.status, 'error')
  assert.deepEqual(result.errors, ['something failed'])
})

test('pollJob throws when timeout exceeded', async () => {
  const client = new POHClient({
    baseUrl: 'http://mock',
    fetch: async () => new Response(
      JSON.stringify({ jobId: 'j3', status: 'processing', total: 5, done: 1, percent: 20, results: [], errors: [], createdAt: '' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ),
  })

  await assert.rejects(
    () => client.pollJob('j3', { interval: 50, timeout: 60 }),
    (err) => err instanceof Error && err.message.includes('did not complete'),
  )
})

// ── watchJob async generator ───────────────────────────────────────────────

test('watchJob yields snapshots until done', async () => {
  let call = 0
  const snaps = [
    { jobId: 'j4', status: 'processing', total: 3, done: 1, percent: 33, results: [], errors: [], createdAt: '' },
    { jobId: 'j4', status: 'processing', total: 3, done: 2, percent: 66, results: [], errors: [], createdAt: '' },
    { jobId: 'j4', status: 'done',       total: 3, done: 3, percent: 100, results: [], errors: [], createdAt: '', completedAt: '' },
  ]

  const client = new POHClient({
    baseUrl: 'http://mock',
    fetch: async () => new Response(
      JSON.stringify(snaps[call++] ?? snaps[snaps.length - 1]),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ),
  })

  const seen = []
  for await (const snap of client.watchJob('j4', { interval: 10 })) {
    seen.push(snap.percent)
  }

  assert.deepEqual(seen, [33, 66, 100])
})

test('watchJob can be broken early without error', async () => {
  const client = new POHClient({
    baseUrl: 'http://mock',
    fetch: async () => new Response(
      JSON.stringify({ jobId: 'j5', status: 'processing', total: 10, done: 1, percent: 10, results: [], errors: [], createdAt: '' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ),
  })

  const seen = []
  for await (const snap of client.watchJob('j5', { interval: 10 })) {
    seen.push(snap.percent)
    if (seen.length >= 2) break
  }

  assert.equal(seen.length, 2)
})

// ── POHError ───────────────────────────────────────────────────────────────

test('POHError is thrown on non-2xx responses', async () => {
  const client = new POHClient({
    baseUrl: 'http://mock',
    localBaseUrl: 'http://mock',
    fetch: async () => new Response(
      JSON.stringify({ error: 'not found' }),
      { status: 404, headers: { 'Content-Type': 'application/json' } },
    ),
  })

  await assert.rejects(
    () => client.scan('0xabc'),
    (err) => err instanceof POHError && err.status === 404 && err.message === 'not found',
  )
})

// ── POHClient constructor ──────────────────────────────────────────────────

test('constructor throws when fetch is unavailable', () => {
  const origFetch = globalThis.fetch
  try {
    // @ts-ignore — simulate environment without fetch
    delete globalThis.fetch
    assert.throws(
      () => new POHClient({ baseUrl: 'http://example.com' }),
      /fetch is unavailable/,
    )
  } finally {
    globalThis.fetch = origFetch
  }
})

test('constructor trims trailing slash from baseUrl', () => {
  const c = new POHClient({ baseUrl: 'https://api.example.com/', fetch: () => Promise.resolve(new Response('{}')) })
  assert.equal(c.activeNode, 'https://api.example.com')
})
