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
