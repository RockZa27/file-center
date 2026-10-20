/**
 * The background queue for e-mail and LINE messages. A request never waits for one: `enqueue` returns at once. A
 * message is tried up to three times, with a pause between tries, unless the server said no for good. A failure is only
 * logged, with the channel and a reason that holds no address, token or password. The queue lives in memory: messages not
 * yet sent are lost in a restart (the bell in the app is kept in notifications.json).
 */
import { log } from './logger'

export const DELIVERY_TIMING = {
  /** the pause before the 2nd and the 3rd try */
  backoffMs: [5_000, 30_000],
  /** sends at the same time */
  parallel: 4,
  /** waiting messages; more are dropped (a flood of uploads must not fill the memory) */
  maxWaiting: 500,
}
export const DELIVERY_TRIES = 3

type Job = { channel: string; run: () => Promise<void> }
const waiting: Job[] = []
let running = 0
const open = new Set<Promise<void>>()
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms).unref())

/** why a send failed, without anything that could be secret: our own errors say it themselves, others only by name */
function reasonOf(err: unknown): string {
  if (err instanceof Error && (err.name === 'MailError' || err.name === 'LineError')) return err.message
  const e = err as { code?: unknown; name?: unknown } | null
  return typeof e?.code === 'string' ? e.code : typeof e?.name === 'string' ? e.name : 'error'
}

async function attempt(job: Job): Promise<void> {
  for (let n = 1; n <= DELIVERY_TRIES; n++) {
    try {
      await job.run()
      return
    } catch (err) {
      const permanent = !!(err as { permanent?: boolean } | null)?.permanent
      if (permanent || n === DELIVERY_TRIES) {
        log.warn('notify-delivery-failed', { channel: job.channel, tries: n, reason: reasonOf(err) })
        return
      }
      await sleep(DELIVERY_TIMING.backoffMs[n - 1] ?? DELIVERY_TIMING.backoffMs.at(-1) ?? 1000)
    }
  }
}

function pump() {
  while (running < DELIVERY_TIMING.parallel && waiting.length) {
    const job = waiting.shift()!
    running++
    const p: Promise<void> = attempt(job).catch(() => {}).finally(() => {
      running--
      open.delete(p)
      pump()
    })
    open.add(p)
  }
}

/** queue a send; false when the queue is full. Never throws, never waits. */
export function enqueue(channel: string, run: () => Promise<void>): boolean {
  if (waiting.length >= DELIVERY_TIMING.maxWaiting) {
    log.warn('notify-queue-full', { channel })
    return false
  }
  waiting.push({ channel, run })
  // not in the caller's tick: the request that caused it answers first
  queueMicrotask(pump)
  return true
}

/** wait until everything queued has been sent or given up (tests) */
export async function deliveryIdle(): Promise<void> {
  while (waiting.length || open.size) {
    pump()
    await Promise.all([...open])
    await Promise.resolve()
  }
}
