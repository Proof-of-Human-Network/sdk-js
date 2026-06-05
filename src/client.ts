import type {
  POHClientOptions,
  NodeConfig,
  FetchFn,
  ScanOptions,
  ScanResult,
  BulkScanResult,
  JobStatus,
  BrainVerdict,
  BrainPollOptions,
  ScanWithVerdict,
  Method,
  PollOptions,
} from './types.js'
import { DEFAULT_NODES } from './types.js'
import { pollUntilDone, watchJob as watchJobGen } from './poller.js'

// ── Error ─────────────────────────────────────────────────────────────────────

export class POHError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.name   = 'POHError'
    this.status = status
  }
}

// ── Node discovery ─────────────────────────────────────────────────────────────

/**
 * Probe a node with a lightweight HEAD /healthz request.
 * Returns the URL on success, rejects on failure or timeout.
 */
async function probeNode(url: string, fetchFn: FetchFn, timeoutMs: number): Promise<string> {
  const ctrl  = typeof AbortController !== 'undefined' ? new AbortController() : undefined
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : undefined
  try {
    const res = await fetchFn(`${url}/healthz`, {
      method: 'HEAD',
      signal: ctrl?.signal as AbortSignal | undefined,
    })
    if (!res.ok && res.status !== 404) throw new Error(`status ${res.status}`)
    return url
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Race all nodes and return the URL of the first that responds. */
async function pickFastestNode(nodes: string[], fetchFn: FetchFn): Promise<string> {
  if (nodes.length === 1) return nodes[0]
  const probes = nodes.map(url =>
    probeNode(url, fetchFn, 4_000).catch(() => null as string | null),
  )
  // Promise.any polyfill: settle all but return first non-null
  return new Promise((resolve, reject) => {
    let remaining = probes.length
    let resolved  = false
    probes.forEach(p =>
      p.then(url => {
        if (!resolved && url !== null) { resolved = true; resolve(url) }
        else if (!resolved && --remaining === 0) reject(new Error('All nodes unreachable'))
      }),
    )
  })
}

/** Try nodes in declared order, return first one that is alive. */
async function pickFirstAlive(nodes: string[], fetchFn: FetchFn): Promise<string> {
  for (const url of nodes) {
    try { return await probeNode(url, fetchFn, 4_000) } catch { /* try next */ }
  }
  throw new Error('All configured PoH nodes are unreachable')
}

// ── Client ────────────────────────────────────────────────────────────────────

export class POHClient {
  private readonly _nodes:        string[]
  private readonly _strategy:     'fastest' | 'first-alive'
  private readonly apiKey:        string | undefined
  private readonly walletAddress: string | undefined
  private readonly _fetch:        FetchFn
  private readonly timeout:       number
  /** Resolved after construction; awaited by every request. */
  private readonly _baseUrlReady: Promise<string>
  /** Cached after first resolution so subsequent requests skip the promise chain. */
  private _cachedBaseUrl: string | undefined

  constructor(options: POHClientOptions) {
    // Resolve fetch: explicit override → globalThis.fetch → error
    const f = options.fetch
      ?? (typeof globalThis !== 'undefined' && (globalThis as { fetch?: FetchFn }).fetch)
      ?? undefined

    if (!f) {
      throw new Error(
        'POHClient: fetch is unavailable in this environment. ' +
        'Pass a fetch implementation via options.fetch (e.g. node-fetch or cross-fetch).',
      )
    }
    this._fetch        = f.bind(globalThis)
    this.apiKey        = options.apiKey
    this.walletAddress = options.walletAddress
    this.timeout       = options.timeout ?? 30_000
    this._strategy     = options.pickStrategy ?? 'fastest'

    if (options.baseUrl) {
      // Legacy single-node path — no discovery needed.
      const url = options.baseUrl.replace(/\/$/, '')
      this._nodes         = [url]
      this._cachedBaseUrl = url
      this._baseUrlReady  = Promise.resolve(url)
    } else {
      const raw  = options.nodes ?? DEFAULT_NODES
      this._nodes = raw
        .map(n => (typeof n === 'string' ? n : (n as NodeConfig).url))
        .map(u => u.replace(/\/$/, ''))

      this._baseUrlReady = (
        this._strategy === 'first-alive'
          ? pickFirstAlive(this._nodes, this._fetch)
          : pickFastestNode(this._nodes, this._fetch)
      ).then(url => {
        this._cachedBaseUrl = url
        return url
      })
    }
  }

  // ── Resolved base URL ─────────────────────────────────────────────────────

  private _getBaseUrl(): Promise<string> {
    return this._cachedBaseUrl
      ? Promise.resolve(this._cachedBaseUrl)
      : this._baseUrlReady
  }

  /** The URL of the node currently in use (undefined before first request resolves). */
  get activeNode(): string | undefined { return this._cachedBaseUrl }

  // ── Internal request ───────────────────────────────────────────────────────

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const baseUrl = await this._getBaseUrl()
    const url     = `${baseUrl}${path}`
    const headers: Record<string, string> = {}

    if (body !== undefined) headers['Content-Type'] = 'application/json'
    if (this.apiKey) headers['x-api-key'] = this.apiKey

    let controller: AbortController | undefined
    let timer: ReturnType<typeof setTimeout> | undefined

    if (typeof AbortController !== 'undefined') {
      controller = new AbortController()
      timer      = setTimeout(() => controller!.abort(), this.timeout)
    }

    try {
      const res = await this._fetch(url, {
        method,
        headers,
        body:   body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller?.signal as AbortSignal | undefined,
      })

      if (!res.ok) {
        const text = await res.text().catch(() => '')
        let msg    = text
        try { msg = (JSON.parse(text) as { error?: string }).error ?? text } catch { /* raw */ }
        throw new POHError(msg || `HTTP ${res.status}`, res.status)
      }

      return res.json() as Promise<T>
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        throw new POHError(`Request timed out after ${this.timeout}ms`, 408)
      }
      throw err
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  // ── Scan ───────────────────────────────────────────────────────────────────

  /**
   * Scan a single wallet address synchronously.
   *
   * @example
   * const { result, brainKey } = await poh.scan('0xabc...')
   * // result: true = human, false = not human, null = inconclusive
   */
  async scan(input: string, options: ScanOptions = {}): Promise<ScanResult> {
    return this.request<ScanResult>('POST', '/checker', {
      input,
      walletAddress: this.walletAddress,
      ...options,
    })
  }

  /**
   * Submit a bulk scan for multiple addresses.
   * Returns a {jobId} immediately; use pollJob() or watchJob() to get results.
   *
   * @example
   * const { jobId } = await poh.scanBulk(['0xaaa...', '0xbbb...'])
   * const results   = await poh.pollJob(jobId)
   */
  async scanBulk(
    inputs: string[],
    options: ScanOptions = {},
  ): Promise<BulkScanResult> {
    if (inputs.length === 0) throw new Error('scanBulk: inputs array must not be empty')
    return this.request<BulkScanResult>('POST', '/checker', {
      input: inputs,
      walletAddress: this.walletAddress,
      ...options,
    })
  }

  // ── Job polling ────────────────────────────────────────────────────────────

  /** Fetch the current snapshot of an async scan job. */
  async getJob(jobId: string): Promise<JobStatus> {
    return this.request<JobStatus>('GET', `/checker/job/${encodeURIComponent(jobId)}`)
  }

  /**
   * Poll a job until it reaches 'done' or 'error', then return the final status.
   *
   * @example
   * const final = await poh.pollJob(jobId, {
   *   interval: 2000,
   *   onProgress: j => console.log(`${j.percent}%`),
   * })
   */
  async pollJob(jobId: string, options: PollOptions = {}): Promise<JobStatus> {
    return pollUntilDone(id => this.getJob(id), jobId, options)
  }

  /**
   * Async generator that yields a status snapshot on every poll tick.
   * Terminates automatically when the job is 'done' or 'error'.
   * The caller may `break` early to cancel without throwing.
   *
   * @example
   * for await (const snap of poh.watchJob(jobId)) {
   *   process.stdout.write(`\r${snap.percent}% (${snap.done}/${snap.total})`)
   * }
   */
  watchJob(jobId: string, options: PollOptions = {}): AsyncGenerator<JobStatus, void, unknown> {
    return watchJobGen(id => this.getJob(id), jobId, options)
  }

  /**
   * Convenience: submit a bulk scan and wait for all results in one call.
   *
   * @example
   * const { results } = await poh.scanAndWait(['0xaaa...', '0xbbb...'])
   */
  async scanAndWait(
    inputs: string[],
    options: ScanOptions & PollOptions = {},
  ): Promise<JobStatus> {
    const { interval, timeout, onProgress, ...scanOpts } = options
    const job = await this.scanBulk(inputs, scanOpts)
    return this.pollJob(job.jobId, { interval, timeout, onProgress })
  }

  // ── Brain verdict ──────────────────────────────────────────────────────────

  /**
   * Retrieve the AI brain verdict for a completed scan.
   * brainKey is returned by scan() once the AI evaluation is ready.
   *
   * @example
   * const { verdict, confidence, reasoning } = await poh.getBrainVerdict(brainKey)
   */
  async getBrainVerdict(brainKey: string): Promise<BrainVerdict> {
    return this.request<BrainVerdict>(
      'GET',
      `/checker/brain/${encodeURIComponent(brainKey)}`,
    )
  }

  /**
   * Poll the brain verdict endpoint until the status leaves `pending`,
   * then return the final verdict.
   *
   * @example
   * const verdict = await poh.pollBrainVerdict(scan.brainKey!)
   * console.log(verdict.verdict, verdict.confidence)
   */
  async pollBrainVerdict(
    brainKey: string,
    options: BrainPollOptions = {},
  ): Promise<BrainVerdict> {
    const interval = options.interval ?? 1_500
    const timeout  = options.timeout  ?? 30_000
    const deadline = Date.now() + timeout

    while (true) {
      const v = await this.getBrainVerdict(brainKey)
      if (v.status !== 'pending') return v
      if (Date.now() + interval > deadline) {
        throw new POHError(`Brain verdict for ${brainKey} did not resolve within ${timeout}ms`, 408)
      }
      await new Promise(r => setTimeout(r, interval))
    }
  }

  /**
   * Convenience: scan a single address and wait for the AI brain verdict.
   * Returns both the raw scan result and the resolved verdict.
   *
   * @example
   * const { scan, verdict } = await poh.scanAndVerdict('0xabc...')
   * console.log(verdict.verdict, verdict.confidence)
   */
  async scanAndVerdict(
    input: string,
    scanOptions: ScanOptions = {},
    brainOptions: BrainPollOptions = {},
  ): Promise<ScanWithVerdict> {
    const scan = await this.scan(input, scanOptions)
    if (!scan.brainKey) {
      return { scan, verdict: { status: 'not_found' } }
    }
    const verdict = await this.pollBrainVerdict(scan.brainKey, brainOptions)
    return { scan, verdict }
  }

  // ── Methods ────────────────────────────────────────────────────────────────

  /**
   * List available signal verification methods, ordered by weighted vote score.
   * Pass a walletAddress to annotate each method with your vote history.
   */
  async getMethods(walletAddress?: string): Promise<Method[]> {
    const addr = walletAddress ?? this.walletAddress
    const qs   = addr ? `?address=${encodeURIComponent(addr)}` : ''
    return this.request<Method[]>('GET', `/verifyer${qs}`)
  }

  /** Fetch a single signal method by its ID. */
  async getMethod(methodId: string): Promise<Method> {
    return this.request<Method>('GET', `/verifyer/${encodeURIComponent(methodId)}`)
  }
}
