import { JsonStore } from './store'
import { EXIT_RESTART } from './release'
import { log } from './logger'

/** true when the launcher started this process, so exiting with EXIT_RESTART brings the app back */
export const supervised = () => process.env.FC_SUPERVISED === '1'

let stopServer: () => Promise<unknown> = async () => {}
let stopping = false

/** index.ts tells us how to stop accepting requests */
export function onStop(fn: () => Promise<unknown>) {
  stopServer = fn
}

/** Finish what is running, write every store to disk, then exit. Never takes longer than `graceMs`. */
export async function shutdown(code: number, graceMs = 8000) {
  if (stopping) return
  stopping = true
  log.info('shutdown', `กำลังหยุดระบบ (code ${code})`)
  setTimeout(() => process.exit(code), graceMs).unref()
  try { await stopServer() } catch { /* exit anyway */ }
  try { await JsonStore.flushAll() } catch { /* exit anyway */ }
  process.exit(code)
}

/** respond first, then restart: the caller's HTTP response has to leave before the server stops */
export function restartSoon(delayMs = 800) {
  setTimeout(() => void shutdown(EXIT_RESTART), delayMs).unref()
}
