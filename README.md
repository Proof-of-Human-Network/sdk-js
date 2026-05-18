# poh-sdk

JavaScript / TypeScript SDK for the [Proof of Human](https://proofofhuman.ge) API.  
Works in **Node.js**, **browsers**, **React Native**, and anywhere `fetch` is available.

## Installation

```bash
npm install poh-sdk
```

## Quick start

```ts
import { POHClient } from 'poh-sdk'

const poh = new POHClient({
  baseUrl: 'https://your-poh-instance.com',
  apiKey:  'your-api-key',           // or use walletAddress for free tier
})

// Single scan
const { result, brainKey } = await poh.scan('0xabc...')
// result: true = human  |  false = not human  |  null = inconclusive

// AI verdict (richer explanation)
const verdict = await poh.getBrainVerdict(brainKey!)
console.log(verdict.reasoning)
```

## Bulk scans with job polling

```ts
// Submit — returns a job ID immediately
const { jobId } = await poh.scanBulk([
  '0xaaa...',
  '0xbbb...',
  '0xccc...',
])

// Option A — wait for completion
const final = await poh.pollJob(jobId, {
  interval:   2_000,           // poll every 2 s (default: 1.5 s)
  timeout:    120_000,         // give up after 2 min (default)
  onProgress: j => console.log(`${j.percent}% complete`),
})
console.log(final.results)

// Option B — stream progress with an async generator
for await (const snap of poh.watchJob(jobId)) {
  process.stdout.write(`\r${snap.percent}% (${snap.done}/${snap.total})`)
}

// Option C — one-liner convenience
const { results } = await poh.scanAndWait(['0xaaa...', '0xbbb...'])
```

## Signal methods

```ts
// List all human-identity signal methods (sorted by vote score)
const methods = await poh.getMethods()

// Single method
const method = await poh.getMethod('methodId')
```

## API reference

### `new POHClient(options)`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `baseUrl` | `string` | **required** | Base URL of the POH API |
| `apiKey` | `string` | — | API key (paid tier) |
| `walletAddress` | `string` | — | Solana wallet for free-tier tracking |
| `fetch` | `FetchFn` | `globalThis.fetch` | Custom fetch (Node < 18, React Native) |
| `timeout` | `number` | `30000` | Per-request timeout in ms |

### Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `scan(input, opts?)` | `Promise<ScanResult>` | Single-address synchronous scan |
| `scanBulk(inputs, opts?)` | `Promise<BulkScanResult>` | Submit bulk job |
| `getJob(jobId)` | `Promise<JobStatus>` | Fetch current job snapshot |
| `pollJob(jobId, opts?)` | `Promise<JobStatus>` | Poll until done/error |
| `watchJob(jobId, opts?)` | `AsyncGenerator<JobStatus>` | Stream updates |
| `scanAndWait(inputs, opts?)` | `Promise<JobStatus>` | Bulk + poll in one call |
| `getBrainVerdict(brainKey)` | `Promise<BrainVerdict>` | AI verdict for a scan |
| `getMethods(walletAddress?)` | `Promise<Method[]>` | List signal methods |
| `getMethod(methodId)` | `Promise<Method>` | Single method by ID |

### Node.js < 18

Pass a fetch implementation via `options.fetch`:

```ts
import fetch from 'node-fetch'
const poh = new POHClient({ baseUrl: '...', fetch })
```

## Error handling

All network errors throw `POHError` with a `.status` (HTTP status code) property.

```ts
import { POHClient, POHError } from 'poh-sdk'

try {
  await poh.scan('0xabc...')
} catch (err) {
  if (err instanceof POHError) {
    console.error(`API error ${err.status}: ${err.message}`)
  }
}
```

## TypeScript

The package ships full `.d.ts` declarations. All request and response types are exported:

```ts
import type { ScanResult, JobStatus, BrainVerdict, Method } from 'poh-sdk'
```

## License

MIT
