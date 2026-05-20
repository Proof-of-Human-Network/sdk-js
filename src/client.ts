import type {
  POHClientOptions,
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

// ── Client ────────────────────────────────────────────────────────────────────

export class POHClient {
  private readonly baseUrl: string
  private readonly apiKey:        string | undefined
  private readonly walletAddress: string | undefined
  private readonly _fetch:        FetchFn
  private readonly timeout:       number

  constructor(options: POHClientOptions) {
    if (!options.baseUrl) throw new Error('POHClient: baseUrl is required')

    this.baseUrl       = options.baseUrl.replace(/\/$/, '')
    this.apiKey        = options.apiKey
    this.walletAddress = options.walletAddress
    this.timeout       = options.timeout ?? 30_000

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
    this._fetch = f.bind(globalThis)
  }

  // ── Internal request ───────────────────────────────────────────────────────

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url     = `${this.baseUrl}${path}`
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
