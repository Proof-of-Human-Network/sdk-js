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
  AskOptions,
  AskJobRef,
  AskJobStatus,
  AskJobResult,
  ChatOptions,
  ChatResult,
  FeedbackResult,
  NodeInfo,
  Skill,
  WalletBalance,
  AccountNonce,
  TxHistoryResult,
  PendingTxResult,
  TxSubmitResult,
  RegisterKeyResult,
  MinerInfo,
  PohTxRecord,
} from './types.js'
import type { PohTx } from './signing.js'
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

  // ── Natural language jobs ──────────────────────────────────────────────────

  /**
   * Route a natural language question and submit it as a skill job.
   * Throws POHError(422) if the router does not match a skill.
   */
  async submitJob(question: string, options: AskOptions = {}): Promise<AskJobRef> {
    const budgetRaw = Math.round((options.budget ?? 0) * 1_000_000_000)
    const route = await this.request<{
      type: 'skill' | 'chat'
      skillId?: string
      input?: object
      reason?: string
    }>('POST', '/chat/route', { message: question, budget: budgetRaw })

    if (route.type !== 'skill' || !route.skillId) {
      throw new POHError(
        route.reason ?? 'No skill matched the question',
        422,
      )
    }

    return this.request<AskJobRef>('POST', '/job', {
      type:             'skill',
      skillId:          route.skillId,
      payload:          route.input ?? {},
      maxBudget:        budgetRaw,
      requesterAddress: options.walletAddress ?? this.walletAddress,
      model:            options.model,
    })
  }

  /**
   * Send a free-form chat message and get a direct LLM reply — no job queue, no fee.
   * Private by default: the connected node only uses its own local LLM. Pass
   * `{ private: false }` to allow falling back to a peer miner or a configured
   * cloud AI provider, which is also required when requesting a `model` that
   * isn't installed locally on the node.
   *
   * @example
   * const { message } = await poh.chat('What is proof of humanity?')
   *
   * @example
   * // Use a specific network model, allowing peer relay
   * const { message } = await poh.chat('Explain this contract', {
   *   model: 'llama3.1:70b',
   *   private: false,
   * })
   */
  async chat(message: string, options: ChatOptions = {}): Promise<ChatResult> {
    return this.request<ChatResult>('POST', '/chat/ask', {
      message,
      history: options.history ?? [],
      model:   options.model,
      private: options.private ?? true,
    })
  }

  /** Fetch the current status of a natural language job. */
  async getJobStatus(jobId: string): Promise<AskJobStatus> {
    return this.request<AskJobStatus>('GET', `/job/${encodeURIComponent(jobId)}/status`)
  }

  /**
   * Fetch the result of a completed natural language job.
   * Returns `{ jobId, status: 'computing', output: null }` when the job is not yet done (HTTP 202).
   */
  async getJobResult(jobId: string): Promise<AskJobResult> {
    const baseUrl = await this._getBaseUrl()
    const url     = `${baseUrl}/job/${encodeURIComponent(jobId)}/result`
    const headers: Record<string, string> = {}
    if (this.apiKey) headers['x-api-key'] = this.apiKey

    let controller: AbortController | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    if (typeof AbortController !== 'undefined') {
      controller = new AbortController()
      timer      = setTimeout(() => controller!.abort(), this.timeout)
    }

    try {
      const res = await this._fetch(url, {
        method: 'GET',
        headers,
        signal: controller?.signal as AbortSignal | undefined,
      })

      if (res.status === 202) {
        return { jobId, status: 'computing', output: null }
      }

      if (!res.ok) {
        const text = await res.text().catch(() => '')
        let msg    = text
        try { msg = (JSON.parse(text) as { error?: string }).error ?? text } catch { /* raw */ }
        throw new POHError(msg || `HTTP ${res.status}`, res.status)
      }

      const data = await res.json() as {
        jobId: string
        verdict?: string
        profile?: { skillOutput?: unknown; skillId?: string; tokensUsed?: number; nlResponse?: string }
        evidence?: unknown
        minerWallet?: string
        error?: string
      }

      return {
        jobId:      data.jobId,
        status:     (data.error ? 'error' : 'done') as 'done' | 'error',
        output:     data.profile?.skillOutput ?? null,
        nlResponse: data.profile?.nlResponse,
        skillId:    data.profile?.skillId,
        tokensUsed: data.profile?.tokensUsed,
        error:      data.error,
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        throw new POHError(`Request timed out after ${this.timeout}ms`, 408)
      }
      throw err
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /**
   * Poll a natural language job until 'done' or 'error', then return the result.
   */
  async pollJobResult(
    jobId: string,
    options: PollOptions = {},
  ): Promise<AskJobResult> {
    const interval = options.interval ?? 1_500
    const timeout  = options.timeout  ?? 120_000
    const deadline = Date.now() + timeout

    while (true) {
      const s = await this.getJobStatus(jobId)
      if (s.status === 'done' || s.status === 'error') return this.getJobResult(jobId)
      if (Date.now() + interval > deadline) {
        throw new POHError(`Job ${jobId} did not complete within ${timeout}ms`, 408)
      }
      await new Promise(r => setTimeout(r, interval))
    }
  }

  /**
   * Route, submit, and wait for a natural language job, returning the final result.
   *
   * @example
   * const result = await poh.askAndWait('Summarise the latest posts from vitalik.eth', {
   *   budget: 0.5,
   *   walletAddress: 'poh...',
   * })
   * console.log(result.nlResponse ?? result.output)
   */
  async askAndWait(
    question: string,
    options: AskOptions & PollOptions = {},
  ): Promise<AskJobResult> {
    const { interval, timeout, budget, walletAddress } = options
    const ref = await this.submitJob(question, { budget, walletAddress })
    return this.pollJobResult(ref.jobId, { interval, timeout })
  }

  /**
   * Rate a completed job 1-5 stars. Feeds the miner's reputation score and
   * (for verdict-scoring jobs) corrects the AI brain's weights.
   * Each job can only be rated once — a second call returns HTTP 409.
   *
   * @example
   * await poh.submitFeedback(jobId, 5)
   */
  async submitFeedback(jobId: string, stars: number, comment?: string): Promise<FeedbackResult> {
    return this.request<FeedbackResult>('POST', `/api/jobs/${encodeURIComponent(jobId)}/feedback`, {
      stars,
      comment,
      requesterAddress: this.walletAddress,
    })
  }

  // ── Node info ──────────────────────────────────────────────────────────────

  /**
   * Fetch metadata about the currently connected node.
   * Returns node ID, version, wallet address, reputation, and peer count.
   */
  async getNodeInfo(): Promise<NodeInfo> {
    return this.request<NodeInfo>('GET', '/healthz')
  }

  /**
   * List all skills available on the connected node.
   * Each skill entry includes its ID, description, and trigger phrases.
   */
  async listSkills(): Promise<Skill[]> {
    return this.request<Skill[]>('GET', '/api/skills')
  }

  // ── Wallet / blockchain ────────────────────────────────────────────────────

  /**
   * Get the POH balance for an address.
   * Balance is returned in μPOH (1 POH = 1 000 000 000 μPOH).
   */
  async getBalance(address: string): Promise<WalletBalance> {
    return this.request<WalletBalance>('GET', `/api/wallet/balance?address=${encodeURIComponent(address)}`)
  }

  /**
   * Get the current transaction nonce for an address.
   * Increment by 1 when building your next transaction.
   */
  async getNonce(address: string): Promise<AccountNonce> {
    return this.request<AccountNonce>('GET', `/api/wallet/nonce?address=${encodeURIComponent(address)}`)
  }

  /**
   * Get the balance journal history (sent / received / mining rewards) for an address.
   * @param limit Max entries to return (default 30).
   */
  async getTransactionHistory(address: string, limit = 30): Promise<TxHistoryResult> {
    const qs = `address=${encodeURIComponent(address)}&limit=${limit}`
    return this.request<TxHistoryResult>('GET', `/api/wallet/history?${qs}`)
  }

  /**
   * Get all raw transaction records involving an address
   * (both submissions by this node and transfers).
   */
  async getTransactions(address: string): Promise<{ address: string; transactions: PohTxRecord[] }> {
    return this.request('GET', `/api/wallet/transactions?address=${encodeURIComponent(address)}`)
  }

  /**
   * Get all transactions currently pending in the mempool.
   */
  async getPendingTransactions(): Promise<PendingTxResult> {
    return this.request<PendingTxResult>('GET', '/api/tx/pending')
  }

  /**
   * Submit a pre-signed PoH transaction to the network.
   *
   * Build and sign the transaction client-side using `buildTransfer()` and
   * `signTransaction()` from `@poh_network/sdk/signing`, then pass the result here.
   *
   * The node validates the signature and nonce, then gossips the transaction
   * to all peers.
   *
   * @example
   * import { buildTransfer, signTransaction } from '@poh_network/sdk'
   *
   * const { nonce } = await poh.getNonce(myAddress)
   * const tx = await buildTransfer(myAddress, recipient, 1.5, nonce + 1)
   * const signed = await signTransaction(tx, myPrivateKeyPem)
   * const { txHash } = await poh.submitTransaction(signed)
   */
  async submitTransaction(tx: PohTx): Promise<TxSubmitResult> {
    return this.request<TxSubmitResult>('POST', '/api/tx/submit', tx)
  }

  /**
   * Register an Ed25519 public key for a wallet address on this node.
   *
   * Required before the node will accept signed transactions from an external wallet.
   * The `proof` is a signature of the wallet address itself — generate it with
   * `createSigningProof(address, privateKeyPem)`.
   *
   * @example
   * import { generateKeyPair, createSigningProof } from '@poh_network/sdk'
   *
   * const { signingPrivateKey, signingPublicKey } = await generateKeyPair()
   * const proof = await createSigningProof(myAddress, signingPrivateKey)
   * await poh.registerSigningKey(myAddress, signingPublicKey, proof)
   */
  async registerSigningKey(
    address: string,
    signingPublicKey: string,
    proof: string,
  ): Promise<RegisterKeyResult> {
    return this.request<RegisterKeyResult>('POST', '/api/wallet/register-key', {
      address,
      signingPublicKey,
      proof,
    })
  }

  /**
   * Convenience: build, sign, and submit a POH transfer in one call.
   *
   * Fetches the current nonce automatically, builds the transaction, signs it,
   * and submits it to the network.
   *
   * @param from           Sender address.
   * @param to             Recipient address.
   * @param amountPOH      Amount in POH units (e.g. 1.5 = 1.5 POH).
   * @param privateKeyPem  PKCS8 PEM private key for signing.
   * @param fee            Miner fee in μPOH (default 0).
   * @param memo           Optional memo string.
   *
   * @example
   * const { txHash } = await poh.transfer('pohAbc...', 'pohXyz...', 5.0, myPrivKey)
   */
  async transfer(
    from: string,
    to: string,
    amountPOH: number,
    privateKeyPem: string,
    fee = 0,
    memo = '',
  ): Promise<TxSubmitResult> {
    const { buildTransfer, signTransaction } = await import('./signing.js')
    const { nonce } = await this.getNonce(from)
    const tx     = await buildTransfer(from, to, amountPOH, nonce + 1, fee, memo)
    const signed = await signTransaction(tx, privateKeyPem)
    return this.submitTransaction(signed)
  }

  /**
   * Get detailed info about the connected miner node:
   * wallet address, gas price, LLM model, queue length, and reputation.
   */
  async getMinerInfo(): Promise<MinerInfo> {
    return this.request<MinerInfo>('GET', '/api/miner/info')
  }
}
