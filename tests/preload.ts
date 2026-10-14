/**
 * Loaded before every test file (bunfig.toml). A global afterAll runs once, after the last file: the folder that
 * tests/in-process-env.ts made for the whole run is removed then, not while another file still uses it.
 */
import { afterAll } from 'bun:test'
import { rmSync } from 'node:fs'

// unset, UPDATE_SOURCE means File Center's official releases on GitHub: no test, nor a server a test starts, may ask it
process.env.UPDATE_SOURCE ??= 'off'

// the stable-channel tests publish config.version as the "latest" release, which a pre-release (1.9.0-beta.1) is not:
// the run pretends to be the release the beta is built on (1.9.0), the code under test is the same
{
  const v = String(require('../package.json').version)
  if (v.includes('-')) process.env.FC_VERSION ??= v.split('-')[0]
}

afterAll(() => {
  const base = (globalThis as any).__fcTestBase
  if (typeof base === 'string') rmSync(base, { recursive: true, force: true })
})
