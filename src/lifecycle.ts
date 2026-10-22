import { JsonStore } from './store'
import { EXIT_RESTART } from './release'
import { log } from './logger'

/** true when the launcher started this process, so exiting with EXIT_RESTART brings the app back */
export const supervised = () => process.env.FC_SUPERVISED === '1'

/** `force`: close the connections that are still open too (the second call, after the drain time) */
let stopServer: (force: boolean) => Promise<unknown> = async () => {}
let stopping = false

/** index.ts tells us how to stop accepting requests */
export function onStop(fn: (force: boolean) => Promise<unknown>) {
  stopServer = fn
}

/** what tests replace: ending the process */
export const exitWith = { exit: (code: number): unknown => process.exit(code) }

/** wait for `p`, but not longer than `ms`; true when it finished */
const settled = (p: Promise<unknown>, ms: number) =>
  Promise.race([p.then(() => true, () => true), new Promise<boolean>(r => setTimeout(() => r(false), ms).unref())])

/**
 * Write every store to disk, stop the server, then exit. Never takes longer than `graceMs`.
 * The stores come first: a long download or upload keeps the server from stopping, and the stores are what a restart
 * must not lose. Requests get a short time to finish (`drainMs`), then the open connections are closed. The stores are
 * flushed once more after that (a request that finished meanwhile may have changed one), and if the grace time runs
 * out first, what is still only in memory is written synchronously before the process leaves.
 */
export async function shutdown(code: number, graceMs = 8000, drainMs = Math.min(3000, graceMs / 2)) {
  if (stopping) return
  stopping = true
  log.info('shutdown', `กำลังหยุดระบบ (code ${code})`)
  setTimeout(() => {
    JsonStore.flushAllSync()
    exitWith.exit(code)
  }, graceMs).unref()
  try { await JsonStore.flushAll() } catch { /* the synchronous write below tries again */ }
  try {
    if (!(await settled(stopServer(false), drainMs))) await settled(stopServer(true), drainMs)
  } catch { /* exit anyway */ }
  try { await JsonStore.flushAll() } catch { /* exit anyway */ }
  JsonStore.flushAllSync()
  exitWith.exit(code)
}

/** respond first, then restart: the caller's HTTP response has to leave before the server stops */
export function restartSoon(delayMs = 800) {
  setTimeout(() => void shutdown(EXIT_RESTART), delayMs).unref()
}
