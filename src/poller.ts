import type { JobStatus, PollOptions } from './types.js'

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Poll a job fetch function repeatedly until the job reaches 'done' or 'error'.
 * Throws if the timeout is exceeded before the job finishes.
 */
export async function pollUntilDone(
  fetchJob: (jobId: string) => Promise<JobStatus>,
  jobId: string,
  options: PollOptions = {},
): Promise<JobStatus> {
  const { interval = 1_500, timeout = 120_000, onProgress } = options
  const deadline = Date.now() + timeout

  while (true) {
    const job = await fetchJob(jobId)
    onProgress?.(job)
    if (job.status === 'done' || job.status === 'error') return job
    if (Date.now() + interval > deadline) {
      throw new Error(
        `POH job "${jobId}" did not complete within ${timeout}ms (last status: ${job.status})`,
      )
    }
    await sleep(interval)
  }
}

/**
 * Async generator that yields a JobStatus snapshot on every poll interval
 * until the job reaches 'done' or 'error'.
 *
 * The caller can `break` early to cancel without error.
 *
 * @example
 * for await (const snap of watchJob(fetchFn, jobId, { interval: 2000 })) {
 *   console.log(`${snap.percent}% — ${snap.done}/${snap.total}`)
 * }
 */
export async function* watchJob(
  fetchJob: (jobId: string) => Promise<JobStatus>,
  jobId: string,
  options: PollOptions = {},
): AsyncGenerator<JobStatus, void, unknown> {
  const { interval = 1_500, timeout = 120_000 } = options
  const deadline = Date.now() + timeout

  while (true) {
    const job = await fetchJob(jobId)
    yield job
    if (job.status === 'done' || job.status === 'error') return
    if (Date.now() + interval > deadline) {
      throw new Error(
        `POH job "${jobId}" did not complete within ${timeout}ms (last status: ${job.status})`,
      )
    }
    await sleep(interval)
  }
}
