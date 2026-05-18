/**
 * Integration smoke-test against a running local POH server.
 * Skipped automatically when BASE_URL is not set.
 *
 * Usage:
 *   BASE_URL=http://localhost:3000 node --test tests/integration.test.js
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

const { POHClient } = await import('../dist/index.js')

const BASE_URL = process.env.BASE_URL
if (!BASE_URL) {
  console.log('Skipping integration tests — set BASE_URL=http://localhost:3000 to run')
  process.exit(0)
}

const poh = new POHClient({ baseUrl: BASE_URL })

describe('integration: single scan', () => {
  test('scan returns a result object', async () => {
    const res = await poh.scan('0x742d35Cc6634C0532925a3b8D4C9E4d8C6b8c9a1')
    assert.ok('result' in res, 'missing result field')
    assert.ok(res.result === true || res.result === false || res.result === null)
  })
})

describe('integration: bulk scan + poll', () => {
  test('scanBulk returns a jobId', async () => {
    const res = await poh.scanBulk([
      '0x742d35Cc6634C0532925a3b8D4C9E4d8C6b8c9a1',
      '0xd3CdA913deB6f4967b2Ef3aa68f5A843Fb6E8C5',
    ])
    assert.ok(typeof res.jobId === 'string' && res.jobId.length > 0)
    assert.ok(['queued', 'processing', 'done'].includes(res.status))
  })

  test('pollJob eventually returns done', async (t) => {
    t.setTimeout(60_000)
    const bulk = await poh.scanBulk(['0x742d35Cc6634C0532925a3b8D4C9E4d8C6b8c9a1'])
    const done = await poh.pollJob(bulk.jobId, { interval: 1000, timeout: 55_000 })
    assert.equal(done.status, 'done')
    assert.ok(done.results.length > 0)
  })

  test('scanAndWait convenience combines both steps', async (t) => {
    t.setTimeout(60_000)
    const done = await poh.scanAndWait(
      ['0x742d35Cc6634C0532925a3b8D4C9E4d8C6b8c9a1'],
      { interval: 1000, timeout: 55_000 },
    )
    assert.equal(done.status, 'done')
  })
})

describe('integration: methods', () => {
  test('getMethods returns an array', async () => {
    const methods = await poh.getMethods()
    assert.ok(Array.isArray(methods))
    if (methods.length > 0) {
      const m = methods[0]
      assert.ok(typeof m.id === 'string')
      assert.ok(typeof m.description === 'string')
      assert.ok(['evm', 'solana', 'rest'].includes(m.type))
    }
  })
})
