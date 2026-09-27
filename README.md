# @poh_network/sdk

JavaScript / TypeScript SDK for the [Decentralized Artificial Intelligence](https://iamai.kg) network.  
Works in **Node.js 18+**, modern **browsers**, and **Deno**.

## Installation

```bash
npm install @poh_network/sdk
```

## Quick start

```ts
import { DAIClient } from '@poh_network/sdk'

const dai = new DAIClient({
  baseUrl: 'https://miner.iamai.kg',       // reads + job polling
  localBaseUrl: 'http://127.0.0.1:3456',             // wallet / tx / job submission
})

// Single scan
const { result, brainKey } = await dai.scan('0xabc...')
// result: true = human  |  false = not human  |  null = inconclusive

// AI verdict
const verdict = await dai.pollBrainVerdict(brainKey!)
console.log(verdict.verdict, verdict.confidence)
```

## Chat

Free-form chat gets a direct LLM reply — no job queue, no fee. **Private by
default**: the connected node only uses its own local LLM. Pass
`{ private: false }` to allow falling back to a peer miner or a configured
cloud AI provider — also required when requesting a `model` that isn't
installed locally on the node.

```ts
const { message } = await dai.chat('What is decentralized artificial intelligence?')

// Specific network model, allowing peer / cloud-provider relay
const { message } = await dai.chat('Explain this contract', {
  model:   'llama3.1:70b',
  private: false,
  history: [{ role: 'user', content: 'earlier turn' }],
})
```

The result may carry `_fromPeer: true` (a peer miner answered) or
`_fromProvider: 'anthropic' | …` (a cloud provider answered).

## Natural language jobs

Skill jobs always require a fee — pass `budget`, `walletAddress`, and
`privateKeyPem` so the SDK can sign the payment. The node verifies the
signature and debits the fee before it will run the job at all; it rejects
the request outright (no job ever runs) without a valid signed payment.
The fee defaults to DAI; pass `currency` to pay in a stablecoin (see
[Stablecoins](#stablecoins-multi-currency)). Pass `model` to restrict the
job to miners running that exact model.

```ts
// Ask a question — returns immediately with a job ID
const ref = await dai.submitJob(
  'What does vitalik.eth write about on Paragraph?',
  { budget: 0.5, walletAddress: 'dai...', privateKeyPem: myPrivateKey },
)

// Wait for the answer
const result = await dai.pollJobResult(ref.jobId)
console.log(result.output)       // skill-specific structured output
console.log(result.nlResponse)   // LLM-generated natural language answer

// One-liner convenience
const result = await dai.askAndWait(
  'What NFTs does gmoney.eth hold?',
  { budget: 0.5, walletAddress: 'dai...', privateKeyPem: myPrivateKey },
)

// Rate the completed job 1–5 stars (once per job — a second call returns HTTP 409)
await dai.submitFeedback(ref.jobId, 5)
```

## Compute jobs (your own model + dataset)

Run inference with a model of your choice, optionally grounded in a Hugging
Face dataset already installed on the node. Like skill jobs, compute jobs
are never free — `runCompute` always signs a fee payment.

```ts
const ref = await dai.runCompute('Summarize the top 5 rows', {
  model:         'llama3.1:8b',
  dataset:       'some-org/some-dataset', // optional
  budget:        0.5,                     // DAI (or `currency` display units)
  walletAddress: myAddress,
  privateKeyPem: myPrivateKey,
})

const result = await dai.pollJobResult(ref.jobId)
console.log(result.output)
```

Before either of these will work, the wallet's signing key must be
registered with the node once via `registerKeyPair()` /
`registerSigningKey()` (see
[Signing & transactions](#signing--transactions)) — the node has no way to
verify a signature for a key it has never seen.

## Estimating a job's fee

Before paying for a job, ask the node what it will cost — the `eth_estimateGas` of
DAI. Send the same fields you would submit (prompt, attachments, a skill, MCP tools, a
dataset). The node sizes the whole pipeline — attachment text, skill and MCP output, dataset
rows, planner and synthesis calls — and returns the AI tokens it will use, the **minimum fee
it accepts**, and a **recommended budget**. It is read-only: nothing runs and nothing is paid.

```ts
const est = await dai.estimate({
  prompt:      'Summarize this report and compare it with the latest news',
  attachments: [{ name: 'report.md', content: reportText }],   // text is inlined and measured
  // skillId: 'web_search', mcp: ['shop__search'], dataset: 'some-org/some-dataset',
  // currency: 'aiKGS', maxOutputTokens: 512, route: false
})

est.fees.minimum.raw        // μDAI the node will accept, at minimum
est.fees.recommended.raw    // μDAI to escrow — covers the worst case
est.tokens.total            // { min, max }
est.breakdown               // what each part contributed, and how sure that is

// runCompute takes DAI; estimate returns μDAI
await dai.runCompute('Summarize this report…', {
  model: 'qwen3-1.7b', walletAddress, privateKeyPem,
  budget: est.fees.recommended.raw! / 1e9,
})
```

What comes back:

| Field | Meaning |
|---|---|
| `tokens` | `prompt`, `output`, `skillCompute` and `total`, each a `{min, max}` range |
| `breakdown` | Every contributor, tagged `measured` (counted exactly — prompt, attachment text, dataset rows), `bounded` (capped by the executing code — what a skill fetched, an MCP tool returned) or `assumed` |
| `calls` | Each model call the pipeline makes (planner, skill answer, synthesis…) |
| `fees.minimum` | The lowest fee the node accepts — bids below it are rejected (`/job` floors at a fixed amount, chat at the prompt alone) |
| `fees.recommended` | Covers the pipeline's worst case, never below the minimum. Escrow this |
| `route` | Which pipeline would run; `predicted: true` means it comes from the deterministic router — the live model-planner may choose differently |
| `outputCap`, `warnings` | Whether the budget caps output, and anything unusual (images are not billed; job output is capped at 512 tokens) |

Amounts are in raw units of the fee currency (**μDAI** for DAI; 1 DAI = 1e9 μDAI), so divide by
1e9 for `runCompute`'s `budget`. For a non-DAI `currency` the price is quoted off the live P2P
book; if nothing quotes that pair the quote says `unavailable` instead of inventing a number,
and a DAI figure is returned alongside.

Needs a node newer than 0.4.36 (it adds `POST /api/estimate`); older nodes answer 404.
`estimate` is read-only, so — unlike the other POST methods — it works against remote nodes
without a `localBaseUrl`.

## Wallet / blockchain

```ts
// Read balance (μDAI — divide by 1e9 for DAI; stablecoins in `assets`)
const { balance, assets } = await dai.getBalance('dai...')
console.log(balance / 1e9, 'DAI')

// Asset registry (DAI + stablecoins) with per-currency gas prices
const { assets: registry, gasPrices } = await dai.getAssets()

// Nonce (needed before building a transaction)
const { nonce } = await dai.getNonce('dai...')

// Transaction history (balance journal: sent / received / mining rewards)
const { entries } = await dai.getTransactionHistory('dai...', 50)

// Raw transaction records involving an address
const { transactions } = await dai.getTransactions('dai...')

// Miner info
const info = await dai.getMinerInfo()
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

// 2. Register the public key with your local node (one-time, per node).
//    registerKeyPair() also derives + publishes the wallet's X25519 encryption
//    key so miners can seal public-job chat records to it.
await dai.registerKeyPair(kp)

// 3. Build, sign, and submit a transfer
const { nonce } = await dai.getNonce(kp.address)
const tx     = await buildTransfer(kp.address, recipient, 5.0, nonce + 1)
const signed = await signTransaction(tx, kp.signingPrivateKey)
const result = await dai.submitTransaction(signed)
console.log(result.txHash)

// One-liner convenience (fetches nonce automatically)
const result = await dai.transfer(kp.address, recipient, 5.0, kp.signingPrivateKey)
```

To replace an already-registered key, build a `createRotationProof(address,
newSigningPublicKey, existingPrivateKeyPem)` signed with the **current** key
and pass it as `rotationProof`.

### Retry safety (idempotent resubmit)

Do **not** wrap `transfer()` in a blind retry — each call fetches a fresh
nonce and builds a NEW transaction, so a retry after a timeout would send
twice. To retry safely, build + sign once and resubmit the **same** signed tx
via `submitTransaction()`: the node treats a duplicate (already queued or
already mined) as an idempotent success and sets `idempotent: true` on the
`TxSubmitResult`.

## Stablecoins (multi-currency)

The chain carries five regional stablecoins alongside DAI: `aiGEL`, `aiKGS`,
`aiAMD`, `aiETB`, `aiBTN` (displayed as αιGEL etc.). They use **2 decimals**
(1 aiGEL = 100 raw units), while DAI keeps 9 (1 DAI = 1e9 μDAI).

```ts
// Transfer 12.50 aiGEL (amount is in the asset's display units)
await dai.transfer(from, to, 12.5, privateKeyPem, 0, '', 'aiGEL')

// Pay a compute job fee in aiKGS — the miner receives exactly aiKGS
await dai.runCompute('Summarize…', {
  model: 'qwen3-1.7b', budget: 5.0, currency: 'aiKGS',
  walletAddress, privateKeyPem,
})

// Balances: DAI scalar + per-asset map
const bal = await dai.getBalance(addr)
// bal.balance → μDAI;  bal.assets → { aiGEL: { raw: 1250, display: 12.5 }, … }
```

Hash compatibility: a DAI transaction/job-payment hashes **exactly** as before
(`currency` enters the signed preimage only when non-DAI), so existing
integrations keep working unchanged.

## Chat record encryption

Public-job chat records (`promptCipher` / `replyCipher`) are sealed to the
requester wallet's X25519 key, derived deterministically from its Ed25519
signing key. `registerKeyPair()` publishes the encryption key automatically.

```ts
import { deriveEncryptionKeypair } from '@poh_network/sdk'

const { publicKeyB64, privateScalarB64 } = deriveEncryptionKeypair(kp.signingPrivateKey)

// Decrypt a sealed field — cleartext input passes through unchanged
const prompt = dai.decryptSealed(record.promptCipher, privateScalarB64)
```

## Skills

```ts
const skills = await dai.listSkills()
skills.forEach(s => console.log(s.id, s.feeMin))
```

## Bulk scans

```ts
const { jobId } = await dai.scanBulk(['0xaaa...', '0xbbb...', '0xccc...'])

// Poll until done
const final = await dai.pollJob(jobId, {
  interval:   2_000,
  onProgress: j => console.log(`${j.percent}% complete`),
})

// Or stream progress
for await (const snap of dai.watchJob(jobId)) {
  process.stdout.write(`\r${snap.percent}% (${snap.done}/${snap.total})`)
}

// One-liner
const { results } = await dai.scanAndWait(['0xaaa...', '0xbbb...'])
```

## Multi-node

```ts
const dai = new DAIClient({
  nodes: [
    'https://miner.iamai.kg',
    'https://iamai.kg',
    'https://miner.iamai.kg',
  ]
})
// Automatically picks the fastest responding node (pickStrategy: 'fastest'),
// or set pickStrategy: 'first-alive' to try nodes in declared order.

dai.activeNode // URL of the node in use (undefined until the first request resolves)
```

## Error handling

```ts
import { DAIClient, DAIError } from '@poh_network/sdk'

try {
  await dai.scan('0xabc...')
} catch (err) {
  if (err instanceof DAIError) {
    console.error(`HTTP ${err.status}: ${err.message}`)
  }
}
```

## API reference

### `new DAIClient(options)`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `baseUrl` | `string` | — | Single-node base URL |
| `nodes` | `string[]` | Default public nodes | Multiple nodes for failover |
| `pickStrategy` | `'fastest' \| 'first-alive'` | `'fastest'` | Node selection when probing `nodes` |
| `apiKey` | `string` | — | API key (paid tier) |
| `walletAddress` | `string` | — | Wallet for free-tier accounting |
| `fetch` | `FetchFn` | `globalThis.fetch` | Custom fetch implementation |
| `timeout` | `number` | `30000` | Per-request timeout (ms) |
| `localBaseUrl` | `string` | — | Local miner URL for wallet/tx/job writes (`http://127.0.0.1:3456`) |

`client.activeNode` (getter) returns the resolved node URL.

### Scanning

| Method | Description |
|--------|-------------|
| `scan(input, opts?)` | Single-address scan |
| `scanBulk(inputs, opts?)` | Submit bulk scan job |
| `getJob(jobId)` | Current snapshot of a bulk scan job |
| `pollJob(jobId, opts?)` | Poll until job completes |
| `watchJob(jobId, opts?)` | Stream job snapshots |
| `scanAndWait(inputs, opts?)` | Bulk scan + poll in one call |
| `getBrainVerdict(brainKey)` | AI verdict for a scan |
| `pollBrainVerdict(brainKey, opts?)` | Poll until verdict resolves |
| `scanAndVerdict(input, opts?)` | Scan + verdict in one call |

### Chat & natural language jobs

| Method | Description |
|--------|-------------|
| `chat(message, opts?)` | Direct LLM reply, no fee. Options: `history`, `model`, `private` (default `true` — local LLM only; `false` allows peer / cloud-provider fallback). |
| `submitJob(question, opts?)` | Submit NL question. Skill jobs always require a fee — pass `budget`, `walletAddress`, `privateKeyPem`; optional `currency` (stablecoin fee) and `model` (restrict to miners running it). |
| `runCompute(prompt, opts)` | Submit a job that runs a specific `model` (and optional `dataset`). Always requires a fee; optional `currency`, `jobId`. |
| `estimate(input)` | Estimate a job's or chat's fee before paying — tokens, minimum fee, recommended budget. Read-only; works on remote nodes. Input: `prompt`/`messages`, `attachments`, `skillId`, `mcp`, `dataset`, `currency`, `maxOutputTokens`, `route`. |
| `getJobStatus(jobId)` | Poll job status |
| `getJobResult(jobId)` | Fetch completed result. A public job leaves `output` empty and sets `replyCipher`; open it with `decryptSealed` |
| `pollJobResult(jobId, opts?)` | Poll until result ready |
| `askAndWait(question, opts?)` | Submit + wait in one call |
| `submitFeedback(jobId, stars, comment?)` | Rate a completed job 1–5 stars (once per job; repeat → HTTP 409) |

### Signal methods

| Method | Description |
|--------|-------------|
| `getMethods(walletAddress?)` | List signal verification methods, ordered by weighted vote score |
| `getMethod(methodId)` | Fetch a single signal method by ID |

### Wallet / blockchain

| Method | Description |
|--------|-------------|
| `getBalance(address)` | Wallet balance in μDAI (+ `assets` map of stablecoin holdings) |
| `getAssets()` | On-chain asset registry (DAI + aiGEL/aiKGS/aiAMD/aiETB/aiBTN) + per-currency gas prices |
| `getNonce(address)` | Current account nonce (+ `pendingNonce` when mempool txs reserve higher) |
| `getTransactionHistory(address, limit?)` | Balance journal history |
| `getTransactions(address)` | Raw transaction records involving an address |
| `getPendingTransactions()` | Mempool pending txs |
| `submitTransaction(tx)` | Submit pre-signed tx. Duplicate resubmits succeed with `idempotent: true` |
| `registerSigningKey(addr, signingPublicKey, proof, rotationProof?, encryptionPublicKey?)` | Register signing key (+ optional X25519 encryption key) |
| `registerKeyPair(keyPair, rotationProof?)` | Register a `generateKeyPair()` result; auto-derives proof + encryption key |
| `transfer(from, to, amount, privateKey, fee?, memo?, currency?)` | Full transfer flow (amount in the currency's display units; DAI default) |
| `decryptSealed(envelopeOrText, privateScalarB64)` | Decrypt a sealed public-job field (cleartext passes through) |

### Signing utilities

| Export | Description |
|--------|-------------|
| `generateKeyPair()` | Fresh Ed25519 keypair (PKCS8 PEM) |
| `deriveAddressFromSigningKey(signingPublicKey)` | Canonical `dai…` address for an SPKI PEM public key |
| `signData(message, privateKeyPem)` | Sign arbitrary data |
| `createSigningProof(address, privateKeyPem)` | Proof for key registration |
| `createRotationProof(address, newSigningPublicKey, existingPrivateKeyPem)` | Proof for replacing a registered key |
| `buildTransfer(from, to, amount, nonce, fee?, memo?, currency?)` | Build unsigned tx (amount in display units of `currency`) |
| `signTransaction(tx, privateKeyPem)` | Sign a tx |
| `computeTxHash(tx)` | SHA-256 tx hash |
| `pemToBytes(pem)` | Decode PEM to bytes |
| `bytesToPem(bytes, type)` | Encode bytes to PEM |
| `computeJobPaymentHash(params)` | Canonical hash for a job fee payment (used internally by `submitJob`/`runCompute`) |
| `signJobPayment(params, privateKeyPem)` | Sign a job fee payment proof (used internally by `submitJob`/`runCompute`) |

### Chat encryption utilities

| Export | Description |
|--------|-------------|
| `deriveEncryptionKeypair(stableSecret)` | X25519 keypair derived from the Ed25519 signing key (`publicKeyB64`, `privateScalarB64`) |
| `seal(recipientPubB64, plaintext)` | Encrypt to a `SealedEnvelope` |
| `open(env, privateScalarB64)` | Decrypt a `SealedEnvelope` |
| `sealJSON(recipientPubB64, obj)` / `openJSON(env, privateScalarB64)` | JSON convenience wrappers |
| `isEnvelope(x)` | Type guard for `SealedEnvelope` |

### Node info

| Method | Description |
|--------|-------------|
| `getNodeInfo()` | Node metadata (/healthz) |
| `getMinerInfo()` | Miner details (gas price, model, reputation) |
| `listSkills()` | Available skills on the node |

## License

MIT
