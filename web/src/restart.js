/** waiting for the server to restart after an update, a rollback or a restore */

export const sleep = ms => new Promise(r => setTimeout(r, ms))

/** the process id of the running server changes with every restart, so a changed `boot` means it came back */
export async function bootId() {
  try {
    const r = await fetch('/api/health', { cache: 'no-store' })
    return r.ok ? (await r.json()).boot : null
  } catch { return null }
}

/**
 * Polls /api/health until a process other than `before` answers. Resolves with that health answer
 * ({ version, boot, ... }), or null when nothing new came up within `timeout` ms.
 */
export async function waitForRestart(before, timeout = 150_000) {
  const deadline = Date.now() + timeout
  await sleep(1500)
  while (Date.now() < deadline) {
    try {
      const r = await fetch('/api/health', { cache: 'no-store' })
      if (r.ok) {
        const h = await r.json()
        if (h.boot !== before) return h
      }
    } catch { /* the server is restarting */ }
    await sleep(1000)
  }
  return null
}
