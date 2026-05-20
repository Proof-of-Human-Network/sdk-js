// ── Client options ─────────────────────────────────────────────────────────────

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>

export interface POHClientOptions {
  /** Base URL of the POH API, e.g. 'https://proofofhuman.ge' */
  baseUrl: string
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

export interface ScanResult {
  /** true = human, false = not human, null = inconclusive */
  result: boolean | null
  /** Key for fetching the AI brain verdict. */
  brainKey?: string
  freeScansLeft?: number
  source?: string
  count?: number
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
