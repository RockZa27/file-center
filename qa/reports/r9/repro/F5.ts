// F5: update packages need no signature unless UPDATE_PUBLIC_KEY is set. We build an update package
// signed by nobody (using the project's own packaging logic), then stage and apply it through the
// real updater module with UPDATE_PUBLIC_KEY empty (the default). applyStaged() runs a "smoke test"
// that spawns the package's server.js as a real subprocess; we prove that subprocess executes
// arbitrary injected code by having it write a marker file, then checking the marker exists.
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setupEnv } from './helper'

const base = setupEnv('f5')
process.env.UPDATE_PUBLIC_KEY = '' // explicit: no signing key configured

const scratchRoot = mkdtempSync(join(tmpdir(), 'fc-f5-pkg-'))
const markerPath = join(scratchRoot, 'pwned-marker.txt')
const distOut = join(scratchRoot, 'dist-update')

async function main() {
  // build an unsigned package with the project's own (copied, unmodified-in-logic) packaging script
  const build = Bun.spawnSync([
    'bun', join(import.meta.dir, 'scratch', 'build-unsigned-package.ts'),
    '--skip-web', '--version', '99.0.0', '--out', distOut, '--marker', markerPath,
  ], { stdout: 'pipe', stderr: 'pipe', cwd: import.meta.dir })
  if (build.exitCode !== 0) {
    console.error('package build failed', build.stdout.toString(), build.stderr.toString())
    process.exit(1)
  }
  const zipPath = join(distOut, 'file-center-99.0.0.zip')
  if (!existsSync(zipPath)) { console.error('package zip missing'); process.exit(1) }

  // import the real app/updater after env is set (UPDATE_PUBLIC_KEY empty -> signatureRequired() === false)
  const { signatureRequired } = await import('../../src/updater')
  if (signatureRequired()) { console.error('unexpected: signature required in this env, test setup wrong'); process.exit(1) }

  const { stagePackage, applyStaged } = await import('../../src/updater')
  const bytes = Bun.file(zipPath).size
  const staged = await stagePackage(zipPath, bytes)
  console.error('staged package:', { version: staged.version, signed: staged.signed, signatureVerified: staged.signatureVerified })
  if (staged.signed || staged.signatureVerified) {
    console.error('package turned out signed/verified: not a useful test of the unsigned path')
    process.exit(1)
  }

  // this runs the package's server.js for real (smoke test) and installs it: no signature was required
  await applyStaged(staged.id)

  const ran = existsSync(markerPath)
  console.error('marker file written by the installed/tested package subprocess:', ran, ran ? readFileSync(markerPath, 'utf8') : '')

  rmSync(scratchRoot, { recursive: true, force: true })

  if (ran) {
    console.error('CONFIRMED: an unsigned update package executed arbitrary code via the smoke-tested subprocess, and was accepted for install')
    process.exit(42)
  }
  console.error('marker never appeared: package code did not run, not confirmed')
  process.exit(0)
}

main()
