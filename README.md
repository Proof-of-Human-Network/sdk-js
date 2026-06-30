# @poh_network/sdk

JavaScript / TypeScript SDK for the [Proof of Human](https://proofofhuman.ge) network.  
Works in **Node.js 18+**, modern **browsers**, and **Deno**.

## Installation

```bash
npm install @poh_network/sdk
```

## Quick start

```ts
import { POHClient } from '@poh_network/sdk'

const poh = new POHClient({
  baseUrl: 'https://bootnode.proofofhuman.ge',       // reads + job polling
  localBaseUrl: 'http://127.0.0.1:3456',             // wallet / tx / job submission
})

// Single scan
const { result, brainKey } = await poh.scan('0xabc...')
// result: true = human  |  false = not human  |  null = inconclusive

// AI verdict
const verdict = await poh.pollBrainVerdict(brainKey!)
console.log(verdict.verdict, verdict.confidence)
```

## Natural language jobs

Skill jobs always require a fee — pass `budget` (POH), `walletAddress`, and
`privateKeyPem` so the SDK can sign the payment. The node verifies the
signature and debits the fee before it will run the job at all; it rejects
the request outright (no job ever runs) without a valid signed payment.

```ts
// Ask a question — returns immediately with a job ID
const ref = await poh.submitJob(
  'What does vitalik.eth write about on Paragraph?',
  { budget: 0.5, walletAddress: 'poh...', privateKeyPem: myPrivateKey },
)

// Wait for the answer
const result = await poh.pollJobResult(ref.jobId)
console.log(result.output)       // skill-specific structured output
console.log(result.nlResponse)   // LLM-generated natural language answer

// One-liner convenience
const result = await poh.askAndWait(
  'What NFTs does gmoney.eth hold?',
  { budget: 0.5, walletAddress: 'poh...', privateKeyPem: myPrivateKey },
)
```

## Compute jobs (your own model + dataset)

Run inference with a model of your choice, optionally grounded in a Hugging
Face dataset already installed on the node. Like skill jobs, compute jobs
are never free — `runCompute` always signs a fee payment.

```ts
const ref = await poh.runCompute('Summarize the top 5 rows', {
  model:         'llama3.1:8b',
  dataset:       'some-org/some-dataset', // optional
  budget:        0.5,                     // POH
  walletAddress: myAddress,
  privateKeyPem: myPrivateKey,
})

const result = await poh.pollJobResult(ref.jobId)
console.log(result.output)
```

Before either of these will work, the wallet's signing key must be
registered with the node once via `registerSigningKey()` (see
[Signing & transactions](#signing--transactions)) — the node has no way to
verify a signature for a key it has never seen.

## Wallet / blockchain

```ts
// Read balance (μPOH — divide by 1e9 for POH)
const { balance } = await poh.getBalance('poh...')
console.log(balance / 1e9, 'POH')

// Nonce (needed before building a transaction)
const { nonce } = await poh.getNonce('poh...')

// Transaction history
const { entries } = await poh.getTransactionHistory('poh...', 50)

// Miner info
const info = await poh.getMinerInfo()
console.log(info.model, info.reputation)
```

## Signing & transactions

```ts
import {
  generateKeyPair,
  buildTransfer,
  signTransaction,
  createSigningProof,
} from '@poh_network/sdk'

// 1. Generate a keypair — address is derived from the signing public key
const kp = await generateKeyPair()

// 2. Register the public key with your local node (one-time, per node)
await poh.registerKeyPair(kp)

// 3. Build, sign, and submit a transfer
const { nonce } = await poh.getNonce(kp.address)
const tx     = await buildTransfer(kp.address, recipient, 5.0, nonce + 1)
const signed = await signTransaction(tx, kp.signingPrivateKey)
const result = await poh.submitTransaction(signed)
console.log(result.txHash)

// One-liner convenience (fetches nonce automatically)
const result = await poh.transfer(kp.address, recipient, 5.0, kp.signingPrivateKey)
```

## Skills

```ts
const skills = await poh.listSkills()
skills.forEach(s => console.log(s.id, s.feeMin))
```

## Bulk scans

```ts
const { jobId } = await poh.scanBulk(['0xaaa...', '0xbbb...', '0xccc...'])

// Poll until done
const final = await poh.pollJob(jobId, {
  interval:   2_000,
  onProgress: j => console.log(`${j.percent}% complete`),
})

// Or stream progress
for await (const snap of poh.watchJob(jobId)) {
  process.stdout.write(`\r${snap.percent}% (${snap.done}/${snap.total})`)
}

// One-liner
const { results } = await poh.scanAndWait(['0xaaa...', '0xbbb...'])
```

## Multi-node

```ts
const poh = new POHClient({
  nodes: [
    'https://bootnode.proofofhuman.ge',
    'https://proofofhuman.ge',
    'https://poh.assetux.com',
  ]
})
// Automatically picks the fastest responding node
```

## Error handling

```ts
import { POHClient, POHError } from '@poh_network/sdk'

try {
  await poh.scan('0xabc...')
} catch (err) {
  if (err instanceof POHError) {
    console.error(`HTTP ${err.status}: ${err.message}`)
  }
}
```

## API reference

### `new POHClient(options)`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `baseUrl` | `string` | — | Single-node base URL |
| `nodes` | `string[]` | Default public nodes | Multiple nodes for failover |
| `apiKey` | `string` | — | API key (paid tier) |
| `walletAddress` | `string` | — | Wallet for free-tier accounting |
| `fetch` | `FetchFn` | `globalThis.fetch` | Custom fetch implementation |
| `timeout` | `number` | `30000` | Per-request timeout (ms) |
| `localBaseUrl` | `string` | — | Local miner URL for wallet/tx/job writes (`http://127.0.0.1:3456`) |

### Scanning

| Method | Description |
|--------|-------------|
| `scan(input, opts?)` | Single-address scan |
| `scanBulk(inputs, opts?)` | Submit bulk scan job |
| `pollJob(jobId, opts?)` | Poll until job completes |
| `watchJob(jobId, opts?)` | Stream job snapshots |
| `scanAndWait(inputs, opts?)` | Bulk scan + poll in one call |
| `getBrainVerdict(brainKey)` | AI verdict for a scan |
| `pollBrainVerdict(brainKey, opts?)` | Poll until verdict resolves |
| `scanAndVerdict(input, opts?)` | Scan + verdict in one call |

### Natural language jobs

| Method | Description |
|--------|-------------|
| `submitJob(question, opts?)` | Submit NL question. Skill jobs always require a fee — pass `budget`, `walletAddress`, `privateKeyPem`. |
| `runCompute(prompt, opts)` | Submit a job that runs a specific `model` (and optional `dataset`). Always requires a fee. |
| `getJobStatus(jobId)` | Poll job status |
| `getJobResult(jobId)` | Fetch completed result |
| `pollJobResult(jobId, opts?)` | Poll until result ready |
| `askAndWait(question, opts?)` | Submit + wait in one call |

### Wallet / blockchain

| Method | Description |
|--------|-------------|
| `getBalance(address)` | Wallet balance in μPOH |
| `getNonce(address)` | Current account nonce |
| `getTransactionHistory(address, limit?)` | Transaction history |
| `getPendingTransactions()` | Mempool pending txs |
| `submitTransaction(tx)` | Submit pre-signed tx |
| `registerSigningKey(addr, pubKeyPem, proof)` | Register signing key |
| `transfer(from, to, amountPOH, privateKey, fee?, memo?)` | Full transfer flow |

### Signing utilities

| Export | Description |
|--------|-------------|
| `generateKeyPair()` | Fresh Ed25519 keypair (PKCS8 PEM) |
| `signData(message, privateKeyPem)` | Sign arbitrary data |
| `createSigningProof(address, privateKeyPem)` | Proof for key registration |
| `buildTransfer(from, to, amountPOH, nonce, fee?, memo?)` | Build unsigned tx |
| `signTransaction(tx, privateKeyPem)` | Sign a tx |
| `computeTxHash(tx)` | SHA-256 tx hash |
| `pemToBytes(pem)` | Decode PEM to bytes |
| `bytesToPem(bytes, type)` | Encode bytes to PEM |
| `computeJobPaymentHash(params)` | Canonical hash for a job fee payment (used internally by `submitJob`/`runCompute`) |
| `signJobPayment(params, privateKeyPem)` | Sign a job fee payment proof (used internally by `submitJob`/`runCompute`) |

### Node info

| Method | Description |
|--------|-------------|
| `getNodeInfo()` | Node metadata (/healthz) |
| `getMinerInfo()` | Miner details (gas price, model, reputation) |
| `listSkills()` | Available skills on the node |

## License

MIT
