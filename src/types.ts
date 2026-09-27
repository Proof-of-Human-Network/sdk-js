// ── Client options ─────────────────────────────────────────────────────────────

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>

/** A single DAI network node entry. */
export interface NodeConfig {
  /** Full base URL of the miner node, e.g. 'https://miner.iamai.kg' */
  url:   string
  /** Human-readable label (optional, for debugging). */
  name?: string
}

/**
 * Default public bootstrap nodes for the DAI network.
 * Used when `nodes` is omitted and no `baseUrl` is given.
 */
export const DEFAULT_NODES: NodeConfig[] = [
  { url: 'https://miner.iamai.kg', name: 'Miner' },
  { url: 'https://iamai.kg',       name: 'Main'  },
]

export interface DAIClientOptions {
  /**
   * Single-node base URL (legacy / backwards-compatible).
   * Takes precedence over `nodes` when provided.
   * e.g. 'https://iamai.kg'
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
  /**
   * Fee currency ticker (aiGEL, aiKGS, aiAMD, aiETB, aiBTN). Omit for DAI.
   * `budget` is then denominated in that currency's display units and the
   * miner receives exactly that currency.
   */
  currency?: string
  /** Budget in DAI (e.g. 0.5 = 0.5 DAI = 500_000_000 μDAI). Required for paid jobs. */
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

// ── File attachments (chat + compute) ─────────────────────────────────────────
// Matches miner MAX_ATTACHMENT_BYTES (1 MB). Text is inlined; images become
// filesystem paths for QVAC multimodal models.

/** Max attachment size accepted by the miner (bytes). */
export const MAX_ATTACHMENT_BYTES = 1 * 1024 * 1024

/**
 * One file attachment for chat/compute.
 * Prefer `dataUrl` for images and `content` for text; `contentBase64` for raw bytes.
 */
export interface ChatAttachment {
  name: string
  mime?: string
  /** Plain-text body (txt/md/json/csv/code). */
  content?: string
  /** Base64-encoded bytes (any type). */
  contentBase64?: string
  /** data:<mime>;base64,... — preferred for images from browsers/RN. */
  dataUrl?: string
}

// ── Compute jobs (user-specified model + dataset) ───────────────────────────────

export interface ComputeOptions {
  /**
   * Fee currency ticker (aiGEL, aiKGS, aiAMD, aiETB, aiBTN). Omit for DAI.
   * `budget` is then denominated in that currency's display units and the
   * miner receives exactly that currency.
   */
  currency?: string
  /** Which model to run, e.g. 'qwen3-1.7b', 'qwen3vl-2b'. */
  model: string
  /** Optional Hugging Face dataset id to ground the answer in (must be installed on the node). */
  dataset?: string
  /** Fee in DAI (e.g. 0.5 = 0.5 DAI). Required — compute jobs are never free. */
  budget: number
  /** Wallet address paying the fee. */
  walletAddress: string
  /** PKCS8 PEM Ed25519 private key used to sign the fee payment. */
  privateKeyPem: string
  /** Optional explicit job id. Auto-generated if omitted. */
  jobId?: string
  /** Prior conversation turns. */
  history?: { role: 'user' | 'assistant' | 'system'; content: string }[]
  /** File attachments (text + images, ≤1 MB each). */
  attachments?: ChatAttachment[]
  /**
   * When false, skip skill/task-cascade auto-routing and run the raw prompt on the model.
   * Default true (miner routes "search the web…" etc. through skills/cascade).
   */
  route?: boolean
}

// ── Fee estimation ────────────────────────────────────────────────────────────

/** Inclusive token bounds. `min === max` when the size is measured exactly. */
export interface TokenRange { min: number; max: number }

/**
 * What to estimate — the same fields a job or chat request carries. Send exactly
 * what you would send to `runCompute()` / `chat()` / the OpenAI-compatible API.
 */
export interface EstimateInput {
  /** `compute` (default) = a paid job; `chat` = OpenAI-style `messages[]`; `skill` = a skill job. */
  type?: 'compute' | 'chat' | 'skill'
  /** The job prompt (or the question, for a skill job). */
  prompt?: string
  /** OpenAI-style messages, for `type: 'chat'` (send this OR `prompt`). */
  messages?: { role: 'system' | 'developer' | 'user' | 'assistant'; content: string }[]
  /** Prior turns. With `requesterAddress`, on-chain public turns are counted too. */
  history?: { role: 'user' | 'assistant' | 'system'; content: string }[]
  /** File attachments. Text is inlined and measured; images are not billed by the node. */
  attachments?: ChatAttachment[]
  /** A specific skill to run (otherwise the node routes from the prompt, as a job would). */
  skillId?: string
  /** MCP tool names (`server__tool`) to run in a cascade. */
  mcp?: string[]
  /** An installed Hugging Face dataset id — the rows the job would inject are measured. */
  dataset?: string
  /** Fee currency ticker; omit for DAI. Non-DAI fees are quoted off the live P2P book. */
  currency?: string
  /** Output tokens to reserve (1..4096, default 512). Jobs cap output at 512 regardless. */
  maxOutputTokens?: number
  /** `false` skips skill/cascade routing, as on a job. */
  route?: boolean
  model?: string
  /** Defaults to the client's `walletAddress`. */
  requesterAddress?: string
  /** The `/job` payload address, if any (it sets the job fee floor). */
  address?: string
}

/** One contributor to the prompt, tagged by how well its size is known. */
export interface EstimateBreakdownItem {
  id: string
  kind: 'prompt' | 'history' | 'attachment' | 'dataset' | 'skill' | 'skill-compute' | 'mcp' | 'planner' | 'hf-model'
  ref?: string
  tokens: TokenRange
  /** measured = counted exactly; bounded = capped by the executing code; assumed = a stated assumption. */
  basis: 'measured' | 'bounded' | 'assumed'
  note?: string
}

/** One model call the pipeline makes. */
export interface EstimateCall {
  purpose: string
  promptTokens: TokenRange
  outputTokens: TokenRange
  basis?: 'assumed'
  note?: string
}

/** A fee in one currency. `raw` is absent when `unavailable` (no market quotes that pair). */
export interface FeeQuote {
  tokens: number
  /** Raw units of `currency` (μDAI for DAI). */
  raw?: number
  currency: string
  /** Endpoint whose floor this is (on `minimum`). */
  gate?: string
  gasPrice?: number
  source?: string
  via?: string
  display?: number
  unavailable?: boolean
  message?: string
}

export interface EstimateResult {
  ok: true
  type: 'compute' | 'chat' | 'skill'
  /** `job` (POST /job) or `chat` (/v1, /openai/v1) — decides which minimum applies. */
  target: 'job' | 'chat'
  model: string
  currency: string
  gasPrice: number
  route: {
    mode: 'direct' | 'routed-skill' | 'cascade' | 'skill-job'
    /** True when the plan comes from the deterministic router; the live model-planner may differ. */
    predicted: boolean
    reason: string | null
    skillId?: string
    tasks?: { id: string; kind: string; skillId?: string; tool?: string }[]
  }
  tokens: { prompt: TokenRange; output: TokenRange; skillCompute: TokenRange; total: TokenRange }
  calls: EstimateCall[]
  breakdown: EstimateBreakdownItem[]
  fees: {
    currency: string
    /** The lowest fee the node accepts — bids below it are rejected. */
    minimum: FeeQuote
    /** Covers the pipeline's worst case (never below `minimum`). Escrow this. */
    recommended: FeeQuote
    /** DAI figures, present when `currency` is not DAI. */
    dai?: { minimum: FeeQuote; recommended: FeeQuote }
  }
  outputCap: { budgetCapApplies: boolean; tokens?: number; note?: string }
  warnings: string[]
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
  /** File attachments (text + images, ≤1 MB). Images auto-select a vision model when needed. */
  attachments?: ChatAttachment[]
  /**
   * Force a dataset id after the user approved a download (from a prior 412
   * `HF_DATASET_DOWNLOAD_REQUIRED` response).
   */
  datasetId?: string
  /** Wallet address used for chain-history matching / public-job context. */
  requesterAddress?: string
}

export interface CascadeJobSummary {
  id?: string
  kind?: string
  skillId?: string
  server?: string
  ok?: boolean
  error?: string
  ms?: number
}

export interface ChatResult {
  /** Discriminator from the miner. Usually 'chat'; may be 'skill' when a paid skill is required. */
  type?: 'chat' | 'skill' | 'cascade' | 'tasks' | 'dataset' | 'hf-model' | 'sequence'
  message: string
  /** Set when a skill answered the question instead of a plain chat reply. */
  skill?: string
  skillId?: string
  /** True when multiple specialists ran (task cascade / multi-skill). */
  cascade?: boolean
  /** True when the unified task-cascade planner ran. */
  tasks?: boolean
  /** Per-task summaries from a cascade. */
  jobs?: CascadeJobSummary[]
  /** Dataset id used or required. */
  dataset?: string
  datasetId?: string
  /** True if a peer miner (not this node's local LLM) produced the reply. */
  _fromPeer?: boolean
  /** Set to the provider id (e.g. 'anthropic') when a configured cloud AI provider produced the reply. */
  _fromProvider?: string
  fromChainHistory?: boolean
  error?: string
  /** Present on HTTP 412 when a HF dataset must be installed first. */
  code?: string
  description?: string
  estimatedSizeBytes?: number | null
  installInstructions?: string
}

// ── HF datasets / MCP status ──────────────────────────────────────────────────

export interface HfDatasetManifest {
  id: string
  source?: string
  installedAt?: number
  rowCount?: number
  files?: { name: string; size: number; sha256?: string }[]
}

export interface HfDatasetListResult {
  datasets: HfDatasetManifest[]
}

export interface HfDatasetDownloadResult {
  ok: boolean
  manifest?: HfDatasetManifest
  error?: string
}

export interface McpServerStatus {
  id: string
  transport?: string
  connected: boolean
  error?: string | null
  tools: string[]
}

export interface McpStatusResult {
  servers: McpServerStatus[]
  tools: { name: string; server?: string; tool?: string; description?: string }[]
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
  /**
   * True when the reply was sealed to the requester's X25519 key.
   * `output` is null until `decryptSealed(replyCipher, privateScalar)` is called.
   */
  encrypted?: boolean
  /** Sealed reply envelope (`profile.replyCipher`). Present on public jobs. */
  replyCipher?: unknown
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
  /** Balance in μDAI (1 DAI = 1 000 000 000 μDAI). */
  balance: number
  /** Stablecoin holdings: ticker → { raw (integer units, 2dp assets ×100), display }. */
  assets?: Record<string, { raw: number; display: number }>
}

/** One on-chain asset from GET /api/assets. */
export interface AssetInfo {
  ticker: string
  decimals: number
  /** UI name, e.g. 'αιGEL' (the wire ticker stays ASCII: 'aiGEL'). */
  display: string
  sign: string
  iso: string | null
  country: string | null
  native: boolean
}

export interface AssetsResult {
  assets: AssetInfo[]
  /** Per-currency gas price (raw units per AI token) currently used by this node. */
  gasPrices?: Record<string, number>
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

export interface DAITxRecord {
  txHash: string
  from:   string
  to:     string
  /** Amount in μDAI. */
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
  queueSize?: number
  /** True when the node recognised this as a resubmit of an already-known tx
   *  (duplicate / already mined) rather than a newly-queued one. Safe to treat
   *  as success — retry with the SAME signed tx, never rebuild at a new nonce. */
  idempotent?: boolean
  note?:     string
}

export interface SendResult {
  success: boolean
  txHash:  string
  status:  string
  message?: string
}

export interface PendingTxResult {
  txs:   DAITxRecord[]
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
