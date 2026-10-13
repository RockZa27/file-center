/**
 * "bun run release --beta": a beta goes to latest-beta.json and never touches latest.json (servers before 1.8.0 read
 * only that one). Runs the real script in a throw-away repository (a copy of this source tree), never against this
 * repository; the packages are built with --skip-web from a one-file web/dist.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { generateKeyPairSync } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dir, '..')
const base = mkdtempSync(join(tmpdir(), 'fc-release-beta-test-'))
const gitEnv = {
  PATH: process.env.PATH!, HOME: base, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'Release Test', GIT_AUTHOR_EMAIL: 'release@test.invalid', GIT_COMMITTER_NAME: 'Release Test', GIT_COMMITTER_EMAIL: 'release@test.invalid',
}
function sh(cmd: string[], cwd: string) {
  const r = Bun.spawnSync(cmd, { cwd, env: gitEnv, stdout: 'pipe', stderr: 'pipe' })
  return { code: r.exitCode, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() }
}
function git(cwd: string, ...a: string[]) {
  const r = sh(['git', ...a], cwd)
  if (r.code !== 0) throw new Error(`git ${a.join(' ')}: ${r.err}`)
  return r.out
}
const keyFile = join(base, 'signing.key')
const release = (repo: string, ...a: string[]) => sh([process.execPath, join(repo, 'scripts', 'release.ts'), '--skip-web', ...a], repo)
const show = (repo: string, file: string) => git(repo, 'show', `updates:${file}`)
const files = (repo: string) => git(repo, 'ls-tree', '--name-only', 'updates').split('\n').sort()

function bump(repo: string, version: string) {
  const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'))
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ ...pkg, version }, null, 2))
  git(repo, 'commit', '--quiet', '-am', `version ${version}`)
}

describe('bun run release --beta', () => {
  let repo = ''

  beforeAll(() => {
    repo = join(base, 'repo')
    mkdirSync(repo)
    for (const p of ['src', 'scripts', 'tsconfig.json']) cpSync(join(root, p), join(repo, p), { recursive: true })
    rmSync(join(repo, 'scripts', 'qa'), { recursive: true, force: true })
    mkdirSync(join(repo, 'web', 'dist'), { recursive: true })
    writeFileSync(join(repo, 'web', 'dist', 'index.html'), '<!doctype html><title>File Center</title>')
    symlinkSync(join(root, 'node_modules'), join(repo, 'node_modules'))
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ ...pkg, version: '1.2.0' }, null, 2))
    writeFileSync(join(repo, '.gitignore'), 'node_modules\nweb/dist/\n')
    git(repo, 'init', '--quiet', '-b', 'main')
    git(repo, 'config', 'commit.gpgsign', 'false')
    git(repo, 'add', '-A')
    git(repo, 'commit', '--quiet', '-m', 'source')
    writeFileSync(keyFile, generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }))
  })
  afterAll(() => rmSync(base, { recursive: true, force: true }))

  test('a beta is written to latest-beta.json only; a stable release may equal its base version; rules of "newer"', () => {
    expect(release(repo, '--sign', keyFile).code).toBe(0)
    const stable = show(repo, 'latest.json')
    expect(JSON.parse(stable)).toMatchObject({ version: '1.2.0' })
    expect(JSON.parse(stable).channel).toBeUndefined()

    // a -beta version is not a normal release
    bump(repo, '1.3.0-beta.1')
    const before = git(repo, 'rev-parse', 'updates')
    const refused = release(repo, '--sign', keyFile)
    expect(refused.code).toBe(1)
    expect(refused.err).toContain('--beta')
    expect(git(repo, 'rev-parse', 'updates')).toBe(before)

    // --beta still needs a signature (or --unsigned on purpose)
    const unsigned = release(repo, '--beta')
    expect(unsigned.code).toBe(1)
    expect(unsigned.err).toContain('--sign')

    const r = release(repo, '--beta', '--sign', keyFile)
    expect(r.code).toBe(0)
    expect(files(repo)).toEqual(['README.md', 'SHA256SUMS', 'file-center-1.2.0.zip', 'file-center-1.3.0-beta.1.zip', 'latest-beta.json', 'latest.json'])
    expect(show(repo, 'latest.json')).toBe(stable)
    const beta = JSON.parse(show(repo, 'latest-beta.json'))
    expect(beta).toMatchObject({ version: '1.3.0-beta.1', file: 'file-center-1.3.0-beta.1.zip', channel: 'beta', signed: true })
    expect(Object.keys(beta).sort()).toEqual([...Object.keys(JSON.parse(stable)), 'channel'].sort())
    expect(show(repo, 'README.md')).toMatch(/\| 1\.3\.0-beta\.1 \*\*เบตา\*\* \|.*\| ใช่ \|/)
    expect(show(repo, 'SHA256SUMS')).toContain('file-center-1.3.0-beta.1.zip')

    // --beta needs a beta version
    bump(repo, '1.3.0')
    const plain = release(repo, '--beta', '--sign', keyFile)
    expect(plain.code).toBe(1)
    expect(plain.err).toContain('-beta')

    // the stable release 1.3.0 follows 1.3.0-beta.1 although it has the same base version; latest-beta.json stays
    expect(release(repo, '--sign', keyFile).code).toBe(0)
    expect(JSON.parse(show(repo, 'latest.json')).version).toBe('1.3.0')
    expect(JSON.parse(show(repo, 'latest-beta.json')).version).toBe('1.3.0-beta.1')

    // a beta must be newer than every published version, stable ones too
    bump(repo, '1.3.0-beta.2')
    const old = release(repo, '--beta', '--sign', keyFile)
    expect(old.code).toBe(1)
    expect(old.err).toContain('1.3.0')
    expect(JSON.parse(show(repo, 'latest-beta.json')).version).toBe('1.3.0-beta.1')
  }, 120_000)
})
