/**
 * "bun run release" publishes packages in the branch `updates`. Runs the real script in throw-away git repos (a copy
 * of this source tree, with a bare "origin" in a temp folder): never against this repository or its branches.
 * The packages are built with --skip-web from a one-file web/dist, so no page build is needed.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { unzipSync } from 'fflate'

const root = resolve(import.meta.dir, '..')
const base = mkdtempSync(join(tmpdir(), 'fc-release-test-'))
// git of the test machine must not leak in: no signing hooks, no global hooks, no prompts
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
const release = (repo: string, ...a: string[]) => sh([process.execPath, join(repo, 'scripts', 'release.ts'), '--skip-web', ...a], repo)
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
const show = (repo: string, ref: string, file: string) => git(repo, 'show', `${ref}:${file}`)

/** a git repo with this source tree at `version`, committed on main */
function makeRepo(name: string, version: string): string {
  const repo = join(base, name)
  mkdirSync(repo)
  for (const p of ['src', 'scripts', 'tsconfig.json']) cpSync(join(root, p), join(repo, p), { recursive: true })
  rmSync(join(repo, 'scripts', 'qa'), { recursive: true, force: true })
  mkdirSync(join(repo, 'web', 'dist'), { recursive: true })
  writeFileSync(join(repo, 'web', 'dist', 'index.html'), '<!doctype html><title>File Center</title>')
  symlinkSync(join(root, 'node_modules'), join(repo, 'node_modules'))
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ ...pkg, version }, null, 2))
  writeFileSync(join(repo, '.gitignore'), 'node_modules\nweb/dist/\n')
  git(repo, 'init', '--quiet', '-b', 'main')
  git(repo, 'config', 'commit.gpgsign', 'false')
  git(repo, 'add', '-A')
  git(repo, 'commit', '--quiet', '-m', 'source')
  return repo
}
function bump(repo: string, version: string) {
  const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'))
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ ...pkg, version }, null, 2))
  git(repo, 'commit', '--quiet', '-am', `version ${version}`)
}
const worktrees = (repo: string) => git(repo, 'worktree', 'list', '--porcelain').split('\n').filter(l => l.startsWith('worktree ')).length

// what origin already holds today: 1.2.0 with README.md and SHA256SUMS, no latest.json
const OLD_ROW = '| 1.2.0 | [file-center-1.2.0.zip](file-center-1.2.0.zip) | `a9053c1` (main) | สำรองข้อมูล, ระบบ log — ยังไม่ได้เซ็น |'
const OLD_README = `# แพ็กเกจอัปเดต File Center

branch นี้เก็บเฉพาะไฟล์แพ็กเกจอัปเดต (ไม่มีโค้ด)

| เวอร์ชัน | ไฟล์ | สร้างจาก commit | หมายเหตุ |
|---|---|---|---|
${OLD_ROW}

## วิธีอัปเดต
1. ดาวน์โหลดไฟล์ .zip จากตารางด้านบน
`
const OLD_ZIP = new TextEncoder().encode('the 1.2.0 package')

describe('bun run release', () => {
  let repo = ''
  let origin = ''

  beforeAll(() => {
    origin = join(base, 'origin.git')
    git(base, 'init', '--quiet', '--bare', origin)
    repo = makeRepo('repo', '1.2.0')
    git(repo, 'remote', 'add', 'origin', origin)
    git(repo, 'push', '--quiet', 'origin', 'main')
    // seed origin's `updates` from another clone, so `repo` has only origin's copy, like a fresh clone
    const seed = join(base, 'seed')
    git(base, 'init', '--quiet', '-b', 'updates', seed)
    git(seed, 'config', 'commit.gpgsign', 'false')
    writeFileSync(join(seed, 'file-center-1.2.0.zip'), OLD_ZIP)
    writeFileSync(join(seed, 'SHA256SUMS'), `${sha(OLD_ZIP)}  file-center-1.2.0.zip\n`)
    writeFileSync(join(seed, 'README.md'), OLD_README)
    git(seed, 'add', '-A')
    git(seed, 'commit', '--quiet', '-m', 'Update package 1.2.0')
    git(seed, 'push', '--quiet', origin, 'updates')
  })

  afterAll(() => rmSync(base, { recursive: true, force: true }))

  test('refuses a working tree with changes', () => {
    writeFileSync(join(repo, 'stray.txt'), 'not committed')
    bump(repo, '1.3.0')
    const r = release(repo, '--push')
    expect(r.code).toBe(1)
    expect(r.err).toContain('stray.txt')
    rmSync(join(repo, 'stray.txt'))
    expect(git(origin, 'ls-tree', '--name-only', 'updates').split('\n')).not.toContain('latest.json')
    expect(worktrees(repo)).toBe(1)
  })

  test('refuses a version that is not newer than one already published (read from the zips, no latest.json yet)', () => {
    git(repo, 'reset', '--quiet', '--hard', 'HEAD~1') // back to 1.2.0
    const r = release(repo, '--push')
    expect(r.code).toBe(1)
    expect(r.err).toContain('1.2.0')
    expect(sh(['git', 'rev-parse', '--verify', '--quiet', 'refs/heads/updates'], repo).code).toBe(0) // taken over from origin
    expect(git(repo, 'rev-parse', 'updates')).toBe(git(origin, 'rev-parse', 'updates'))
  })

  test('the first release keeps the 1.2.0 row, adds latest.json and pushes with --push', () => {
    bump(repo, '1.3.0')
    const r = release(repo, '--notes', 'share links | update button', '--push')
    expect(r.code).toBe(0)
    expect(git(repo, 'rev-parse', 'updates')).toBe(git(origin, 'rev-parse', 'updates'))
    // on top of origin's history, not a second one
    expect(git(origin, 'rev-list', '--count', 'updates')).toBe('2')
    expect(git(origin, 'ls-tree', '--name-only', 'updates').split('\n').sort()).toEqual(['README.md', 'SHA256SUMS', 'file-center-1.2.0.zip', 'file-center-1.3.0.zip', 'latest.json'])

    const zip = new Uint8Array(Bun.spawnSync(['git', 'show', 'updates:file-center-1.3.0.zip'], { cwd: origin, env: gitEnv }).stdout)
    const latest = JSON.parse(show(origin, 'updates', 'latest.json'))
    expect(latest).toEqual({
      version: '1.3.0', file: 'file-center-1.3.0.zip', sha256: sha(zip), size: zip.length, builtAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
      commit: git(repo, 'rev-parse', '--short', 'HEAD'), notes: 'share links | update button', signed: false,
    })
    const manifest = JSON.parse(new TextDecoder().decode(unzipSync(zip)['manifest.json']))
    expect(manifest).toMatchObject({ version: '1.3.0', notes: 'share links | update button', builtAt: latest.builtAt })
    expect(show(origin, 'updates', 'SHA256SUMS')).toBe(`${sha(OLD_ZIP)}  file-center-1.2.0.zip\n${sha(zip)}  file-center-1.3.0.zip`)

    const readme = show(origin, 'updates', 'README.md')
    expect(readme).toContain('| เวอร์ชัน | ไฟล์ | สร้างจาก commit | หมายเหตุ | เซ็น |')
    expect(readme).toContain(`${OLD_ROW} - |`)
    expect(readme).toContain(`| 1.3.0 | [file-center-1.3.0.zip](file-center-1.3.0.zip) | \`${latest.commit}\` (main) | share links \\| update button | ไม่ |`)
    // newest first, the rest of the page as it was
    expect(readme.indexOf('| 1.3.0 |')).toBeLessThan(readme.indexOf('| 1.2.0 |'))
    expect(readme).toContain('## วิธีอัปเดต')
    expect(worktrees(repo)).toBe(1)
    expect(git(repo, 'status', '--porcelain')).toBe('')
  }, 60_000)

  test('without --push nothing leaves the machine; --sign is passed to the package', () => {
    bump(repo, '1.4.0')
    const keyFile = join(base, 'signing.key')
    writeFileSync(keyFile, generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }))
    const r = release(repo, '--sign', keyFile)
    expect(r.code).toBe(0)
    expect(git(repo, 'rev-parse', 'updates')).not.toBe(git(origin, 'rev-parse', 'updates'))
    expect(JSON.parse(show(origin, 'updates', 'latest.json')).version).toBe('1.3.0')
    const latest = JSON.parse(show(repo, 'updates', 'latest.json'))
    expect(latest).toMatchObject({ version: '1.4.0', signed: true, notes: '' })
    const zip = new Uint8Array(Bun.spawnSync(['git', 'show', 'updates:file-center-1.4.0.zip'], { cwd: repo, env: gitEnv }).stdout)
    expect(Object.keys(unzipSync(zip))).toContain('manifest.sig')
    expect(show(repo, 'updates', 'README.md')).toMatch(/\| 1\.4\.0 \|.*\| - \| ใช่ \|/)
    expect(show(repo, 'updates', 'SHA256SUMS').split('\n')).toHaveLength(3)
    // the same version again: refused (now read from latest.json too)
    expect(release(repo).code).toBe(1)
  }, 60_000)

  test('the temporary worktree is removed when something fails half way', () => {
    bump(repo, '1.5.0')
    const before = git(repo, 'rev-parse', 'updates')
    // the commit in the worktree fails: hooks are shared by every worktree of the repo
    const hook = join(repo, '.git', 'hooks', 'pre-commit')
    writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    try {
      const r = release(repo, '--push')
      expect(r.code).toBe(1)
    } finally {
      rmSync(hook)
    }
    expect(worktrees(repo)).toBe(1)
    expect(git(repo, 'rev-parse', 'updates')).toBe(before)
    // and a key that does not exist stops it before anything is touched
    const r = release(repo, '--sign', join(base, 'missing.key'))
    expect(r.code).toBe(1)
    expect(worktrees(repo)).toBe(1)
    expect(git(repo, 'rev-parse', 'updates')).toBe(before)
  }, 60_000)

  test('without any `updates` branch it starts one with no history and a Thai README', () => {
    const fresh = makeRepo('fresh', '1.0.0')
    const r = release(fresh)
    expect(r.code).toBe(0)
    expect(git(fresh, 'rev-list', '--count', 'updates')).toBe('1')
    expect(git(fresh, 'ls-tree', '--name-only', 'updates').split('\n').sort()).toEqual(['README.md', 'SHA256SUMS', 'file-center-1.0.0.zip', 'latest.json'])
    const readme = show(fresh, 'updates', 'README.md')
    expect(readme).toContain('# แพ็กเกจอัปเดต File Center')
    expect(readme).toMatch(/\| เวอร์ชัน \| ไฟล์ \| สร้างจาก commit \| หมายเหตุ \| เซ็น \|\n\|---\|---\|---\|---\|---\|\n\| 1\.0\.0 \|/)
    expect(git(fresh, 'branch', '--show-current')).toBe('main')
    expect(git(fresh, 'status', '--porcelain')).toBe('')
    expect(worktrees(fresh)).toBe(1)
  }, 60_000)
})
