// ── Client options ─────────────────────────────────────────────────────────────

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>

/** A single PoH network node entry. */
export interface NodeConfig {
  /** Full base URL of the miner node, e.g. 'https://miner.proofofhuman.ge' */
  url:   string
  /** Human-readable label (optional, for debugging). */
  name?: string
}

/**
 * Default public bootstrap nodes for the PoH network.
 * Used when `nodes` is omitted and no `baseUrl` is given.
 */
export const DEFAULT_NODES: NodeConfig[] = [
  { url: 'https://bootnode.proofofhuman.ge', name: 'Bootnode' },
  { url: 'https://proofofhuman.ge',          name: 'Main'     },
  { url: 'https://poh.assetux.com',          name: 'Relay'    },
]

export interface POHClientOptions {
  /**
   * Single-node base URL (legacy / backwards-compatible).
   * Takes precedence over `nodes` when provided.
   * e.g. 'https://proofofhuman.ge'
   */
  baseUrl?: string
  /**
   * List of network nodes to probe.
   * The client races health-checks against all of them and uses the fastest
   * responding one. Sticks to that node for the lifetime of the client so
   * in-progress job IDs remain routable.
   * Falls back to DEFAULT_NODES when neither `baseUrl` nor `nodes` is provided.
   */
  nodes?: (string | NodeConfig)[]
  /**
   * Node selection strategy when probing multiple nodes.
   * - 'fastest'     (default) — use whichever node responds first
   * - 'first-alive' — try nodes in order, use first that is up
   */
  pickStrategy?: 'fastest' | 'first-alive'
  /** API key for paid tier. Mutually exclusive with walletAddress. */
  apiKey?: string
  /** Solana wallet address for free-tier request tracking. */
  walletAddress?: string
  /**
   * Custom fetch implementation.
   * Required for Node.js < 18 or React Native — pass node-fetch or cross-fetch.
   * Defaults to globalThis.fetch.
   */
  fetch?: FetchFn
  /** Per-request timeout in milliseconds. Default: 30 000 */
  timeout?: number
  /**
   * Local miner node URL for state-changing requests (wallet, tx, jobs).
   * Required when `baseUrl`/`nodes` point at a remote bootnode — those endpoints
   * are localhost-only on the miner. Example: `http://127.0.0.1:3456`
   */
  localBaseUrl?: string
}

// ── Scan ───────────────────────────────────────────────────────────────────────

export interface ScanOptions {
  /** Restrict evaluation to specific chain IDs (e.g. ['1', '137']). */
  chainIds?: string[]
  /** On-chain payment transaction hash (for paid scans). */
  txHash?: string
}

export interface OfacMatch {
  sanctioned: true
  name:     string
  program:  string
  chainCode: string
  /** `'direct'` = the scanned address itself; `'counterparty'` = a 1-hop tx partner. */
  type:         'direct' | 'counterparty'
  matchedAddress: string
}

export interface ScanResult {
  /** true = human, false = not human, null = inconclusive */
  result: boolean | null
  /** Key for fetching the AI brain verdict. */
  brainKey?: string
  freeScansLeft?: number
  source?: string
  count?: number
  /** Present when the address (or a direct counterparty) is on the OFAC SDN list. */
  ofac?: OfacMatch | null
}

export interface BulkScanResult {
  jobId: string
  status: JobStatus['status']
  total: number
  /** URL path for polling — convenience, same as /checker/job/:jobId */
  pollUrl: string
  freeScansLeft?: number
}

// ── Jobs ───────────────────────────────────────────────────────────────────────

export type JobStatusCode = 'queued' | 'processing' | 'done' | 'error'

export interface ScanResultItem {
  input: string
  result: boolean | null
  error?: string
}

export interface JobStatus {
  jobId: string
  status: JobStatusCode
  total: number
  done: number
  percent: number
  results: ScanResultItem[]
  errors: string[]
  createdAt: string
  completedAt?: string
}

// ── Poll ───────────────────────────────────────────────────────────────────────

export interface PollOptions {
  /** Milliseconds between status checks. Default: 1 500 */
  interval?: number
  /** Maximum total wait time in milliseconds. Default: 120 000 */
  timeout?: number
  /** Called on every status update while polling. */
  onProgress?: (job: JobStatus) => void
}

// ── Brain / verdict ────────────────────────────────────────────────────────────

export interface BrainVerdict {
  status: string
  /** `"HUMAN"` | `"AI"` | `"UNCERTAIN"` — undefined while pending */
  verdict?: 'HUMAN' | 'AI' | 'UNCERTAIN'
  confidence?: number
  signals?: Record<string, number>
  reasoning?: string
}

export interface BrainPollOptions {
  /** Milliseconds between brain verdict checks. Default: 1 500 */
  interval?: number
  /** Maximum total wait in milliseconds. Default: 30 000 */
  timeout?: number
}

/** Combined result of scanAndVerdict(): raw scan evidence + AI verdict. */
export interface ScanWithVerdict {
  scan: ScanResult
  verdict: BrainVerdict
}

// ── Methods ───────────────────────────────────────────────────────────────────

export interface Method {
  id: string
  type: 'evm' | 'solana' | 'rest'
  description: string
  address?: string
  method?: string
  score: number
  voteCount?: number
  chainId?: string
  expression?: string
}

// ── Natural language jobs ──────────────────────────────────────────────────────

export interface AskOptions {
  /** Budget in POH (e.g. 0.5 = 0.5 POH = 500_000_000 μPOH). Required for paid jobs. */
  budget?: number
  /** Wallet address to charge the budget from. Required when budget > 0. */
  walletAddress?: string
  /**
   * Restrict the job to miners running this exact model (e.g. 'qwen2.5:1.5b', 'llama3.1:8b').
   * Omit to let any available miner handle it.
   */
  model?: string
  /**
   * PKCS8 PEM Ed25519 private key used to sign the fee payment.
   * Required when `budget > 0` — skill jobs always require a fee, and the node
   * rejects the job outright without a valid signed payment proof.
   */
  privateKeyPem?: string
}

// ── Compute jobs (user-specified model + dataset) ───────────────────────────────

export interface ComputeOptions {
  /** Which model to run, e.g. 'qwen2.5:1.5b', 'llama3.1:8b'. */
  model: string
  /** Optional Hugging Face dataset id to ground the answer in (must be installed on the node). */
  dataset?: string
  /** Fee in POH (e.g. 0.5 = 0.5 POH). Required — compute jobs are never free. */
  budget: number
  /** Wallet address paying the fee. */
  walletAddress: string
  /** PKCS8 PEM Ed25519 private key used to sign the fee payment. */
  privateKeyPem: string
  /** Optional explicit job id. Auto-generated if omitted. */
  jobId?: string
}

// ── Chat ──────────────────────────────────────────────────────────────────────

export interface ChatOptions {
  /** Prior conversation turns, oldest first. */
  history?: { role: 'user' | 'assistant' | 'system'; content: string }[]
  /** Specific model to use. If not installed locally on the node, it's relayed to a peer running it. */
  model?: string
  /**
   * Private (default true): the node only uses its own local LLM — never relays to a
   * peer miner or a configured cloud AI provider.
   * Public (false): allowed to fall back to a peer or a configured cloud AI provider
   * (Claude/OpenAI/Grok) if the local LLM is unavailable, and required for `model`s
   * that aren't installed locally on the node.
   */
  private?: boolean
}

export interface ChatResult {
  message: string
  /** Set when a skill answered the question instead of a plain chat reply. */
  skill?: string
  /** True if a peer miner (not this node's local LLM) produced the reply. */
  _fromPeer?: boolean
  /** Set to the provider id (e.g. 'anthropic') when a configured cloud AI provider produced the reply. */
  _fromProvider?: string
  error?: string
}

// ── Feedback ──────────────────────────────────────────────────────────────────

export interface FeedbackResult {
  ok: boolean
  jobId: string
  rating: 'positive' | 'negative' | 'neutral'
  stars: number | null
}

export interface AskJobRef {
  jobId: string
  status: string
  statusUrl?: string
  resultUrl?: string
  message?: string
}

export interface AskJobStatus {
  jobId: string
  status: 'queued' | 'computing' | 'done' | 'error'
  error?: string
  updatedAt?: string
}

/** Final result returned after a natural language job completes. */
export interface AskJobResult {
  jobId: string
  status: 'done' | 'error' | 'computing'
  /** The skill's answer. Shape depends on which skill ran (e.g. read_paragraph returns author + posts + analysis). */
  output: unknown
  /** Natural language answer generated by the miner's LLM from the skill output. Present when the job included a question. */
  nlResponse?: string
  /** Which skill handled the question. */
  skillId?: string
  /** Tokens billed for the job. */
  tokensUsed?: number
  error?: string
}

// ── Node info ─────────────────────────────────────────────────────────────────

export interface NodeInfo {
  status: string
  nodeId?: string
  version?: string
  wallet?: string
  reputation?: number
  uptime?: number
  peers?: number
}

// ── Skills ────────────────────────────────────────────────────────────────────

export interface Skill {
  id: string
  version?: string
  description?: string
  triggers?: string[]
  feeMin?: number
}

// ── Wallet / blockchain ────────────────────────────────────────────────────────

export interface WalletBalance {
  address: string
  /** Balance in μPOH (1 POH = 1 000 000 000 μPOH). */
  balance: number
}

export interface AccountNonce {
  address: string
  nonce: number
  /** Highest nonce reserved by pending mempool transactions, if any. */
  pendingNonce?: number
}

export interface TxHistoryEntry {
  height:  number
  delta:   number
  txHash:  string
  ts:      number
  label:   string
}

export interface TxHistoryResult {
  address: string
  entries: TxHistoryEntry[]
}

export interface PohTxRecord {
  txHash: string
  from:   string
  to:     string
  /** Amount in μPOH. */
  amount: number
  fee:    number
  nonce:  number
  timestamp?: number
  memo?:  string
  status?: string
}

export interface TxSubmitResult {
  ok:        boolean
  txHash:    string
  queueSize: number
}

export interface SendResult {
  success: boolean
  txHash:  string
  status:  string
  message?: string
}

export interface PendingTxResult {
  txs:   PohTxRecord[]
  count: number
}

export interface RegisterKeyResult {
  ok: boolean
}

export interface MinerInfo {
  minerAddress: string
  gasPrice:     number
  model:        string
  queueLength:  number
  reputation:   number
}
