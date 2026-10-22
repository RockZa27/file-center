/**
 * Loaded before every test file (bunfig.toml). A global afterAll runs once, after the last file: the folder that
 * tests/in-process-env.ts made for the whole run is removed then, not while another file still uses it.
 */
import { afterAll, setDefaultTimeout } from 'bun:test'
import { rmSync } from 'node:fs'

// unset, UPDATE_SOURCE means File Center's official releases on GitHub: no test, nor a server a test starts, may ask it
process.env.UPDATE_SOURCE ??= 'off'

// every file shares one in-process app, so a test can wait behind another file's backup, update or thumbnail work
// still running; tests that take under a second alone have hit Bun's 5 s default that way. A real hang still fails.
setDefaultTimeout(20_000)

afterAll(() => {
  const base = (globalThis as any).__fcTestBase
  if (typeof base === 'string') rmSync(base, { recursive: true, force: true })
})
