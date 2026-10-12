/**
 * Loaded before every test file (bunfig.toml). A global afterAll runs once, after the last file: the folder that
 * tests/in-process-env.ts made for the whole run is removed then, not while another file still uses it.
 */
import { afterAll } from 'bun:test'
import { rmSync } from 'node:fs'

afterAll(() => {
  const base = (globalThis as any).__fcTestBase
  if (typeof base === 'string') rmSync(base, { recursive: true, force: true })
})
