/**
 * FC_UMASK applies only to a process that owns DATA_DIR (root running the CLI keeps its own umask), and a data file
 * the account cannot read is reported as a permission problem, never as "damaged" (no .broken- copy, no reset).
 */
import { describe, expect, test } from 'bun:test'
import { chmodSync, chownSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { effectiveUmask } from '../src/config'
import { unreadableMessage } from '../src/store'

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0
const root = resolve(import.meta.dir, '..')
const run = (cmd: string[], env: Record<string, string>) =>
  Bun.spawnSync({ cmd, env: { ...(process.env as Record<string, string>), ...env }, stdout: 'pipe', stderr: 'pipe' })

describe('effectiveUmask', () => {
  test('owner is the process: the setting', () => {
    expect(effectiveUmask({ setting: 0o077, processUid: 1000, dataOwnerUid: 1000, current: 0o022 })).toBe(0o077)
  })
  test('owner is another account: the current umask stays', () => {
    expect(effectiveUmask({ setting: 0o077, processUid: 0, dataOwnerUid: 1000, current: 0o022 })).toBe(0o022)
  })
  test('DATA_DIR not there yet or no getuid: the setting', () => {
    expect(effectiveUmask({ setting: 0o077, processUid: 0, dataOwnerUid: null, current: 0o022 })).toBe(0o077)
    expect(effectiveUmask({ setting: 0o027, processUid: null, dataOwnerUid: 5, current: 0o022 })).toBe(0o027)
  })
})

describe('config in a subprocess', () => {
  test('umask of the process after loading config', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fc-own-'))
    try {
      const data = join(dir, 'data')
      mkdirSync(data)
      if (isRoot) chownSync(data, 65534, 65534) // not owned by this (root) process
      const script = `import ${JSON.stringify(join(root, 'src/config.ts'))}; console.log(process.umask())`
      const out = run(['sh', '-c', `umask 022; exec bun -e '${script}'`], { DATA_DIR: data, STORAGE_DIR: join(dir, 'storage'), BACKUP_DIR: join(dir, 'backups'), FC_UMASK: '' })
      // root: DATA_DIR belongs to someone else, the started umask stays; otherwise the process owns it: 077
      expect(out.stdout.toString().trim()).toBe(String(isRoot ? 0o022 : 0o077))
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('unreadable data file', () => {
  test('message says permission, with owner, mode and app uid', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fc-msg-'))
    try {
      const f = join(dir, 'users.json')
      writeFileSync(f, '[]')
      chmodSync(f, 0o600)
      const m = unreadableMessage(f, new Error('EACCES'), 1000)
      expect(m).toContain('uid 1000')
      expect(m).toContain('mode 600')
      expect(m).toContain('chown -R 1000:1000')
      expect(m).toContain('exec -u bun')
      expect(m).not.toContain('file is damaged')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('JsonStore onCorrupt fail: permission message, file untouched, no .broken- copy', () => {
    const mode = 'fail'
    const dir = mkdtempSync(join(tmpdir(), 'fc-ro-'))
    const f = join(dir, 'users.json')
    try {
      chmodSync(dir, 0o777) // the unprivileged subprocess makes its DATA_DIR and STORAGE_DIR inside
      writeFileSync(f, '[{"a":1}]')
      chmodSync(f, 0o000)
      const script = `import {JsonStore} from ${JSON.stringify(join(root, 'src/store.ts'))}
try { new JsonStore(${JSON.stringify(f)}, () => [], { onCorrupt: ${JSON.stringify(mode)} }); console.log('NOERROR') } catch (e) { console.log('ERR:' + e.message) }`
      // root reads a 0000 file, so an unprivileged account in a subprocess is the honest way to get EACCES
      const cmd = isRoot
        ? ['setpriv', '--reuid=65534', '--regid=65534', '--clear-groups', 'bun', '-e', script]
        : ['bun', '-e', script]
      const out = run(cmd, { DATA_DIR: join(dir, 'data'), STORAGE_DIR: join(dir, 'storage'), BACKUP_DIR: join(dir, 'backups') })
      const text = out.stdout.toString()
      expect(text).toContain('ERR:')
      expect(text).toContain('permission denied')
      expect(text).not.toContain('file is damaged')
      expect(readdirSync(dir).filter(n => n.includes('.broken-'))).toEqual([])
      expect(existsSync(f)).toBe(true)
    } finally {
      try { chmodSync(f, 0o600) } catch { /* gone */ }
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

/** a script run as an account that cannot read `f` (root reads a 0000 file, so setpriv to an unprivileged uid) */
function asOther(dir: string, script: string) {
  const cmd = isRoot
    ? ['setpriv', '--reuid=65534', '--regid=65534', '--clear-groups', 'bun', '-e', script]
    : ['bun', '-e', script]
  return run(cmd, { DATA_DIR: join(dir, 'data'), STORAGE_DIR: join(dir, 'storage'), BACKUP_DIR: join(dir, 'backups') })
}

describe('unreadable file in a reset store', () => {
  test('starts with the fallback, warns, keeps the file and its mode under .unreadable-<ts>', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fc-reset-'))
    const f = join(dir, 'sessions.json')
    try {
      chmodSync(dir, 0o777)
      writeFileSync(f, '{"old":1}')
      chmodSync(f, 0o000)
      const script = `import {JsonStore} from ${JSON.stringify(join(root, 'src/store.ts'))}
try { const s = new JsonStore(${JSON.stringify(f)}, () => ({ fresh: true })); console.log('DATA:' + JSON.stringify(s.value)) } catch (e) { console.log('ERR:' + e.message) }`
      const out = asOther(dir, script)
      expect(out.stdout.toString()).toContain('DATA:{"fresh":true}')
      expect(out.stderr.toString()).toContain('[store-unreadable]')
      expect(out.stderr.toString()).toContain('sessions.json')
      expect(readdirSync(dir).filter(n => n.includes('.broken-'))).toEqual([])
      // the file is moved aside whole (same bytes, same mode), not copied or read
      const kept = join(dir, readdirSync(dir).find(n => n.startsWith('sessions.json.unreadable-'))!)
      expect(statSync(kept).mode & 0o777).toBe(0)
      chmodSync(kept, 0o600)
      expect(readFileSync(kept, 'utf8')).toBe('{"old":1}')
    } finally {
      for (const n of readdirSync(dir)) try { chmodSync(join(dir, n), 0o600) } catch { /* gone */ }
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('the unreadable file is kept as .unreadable-<ts>; the next save does not touch the kept copy', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fc-keep-'))
    const f = join(dir, 'sessions.json')
    try {
      chmodSync(dir, 0o777)
      writeFileSync(f, '{"old":1}')
      chmodSync(f, 0o000)
      const script = `import {JsonStore} from ${JSON.stringify(join(root, 'src/store.ts'))}
const s = new JsonStore(${JSON.stringify(f)}, () => ({ fresh: true }))
console.log('DATA:' + JSON.stringify(s.value))
s.save(); await s.idle(); console.log('SAVED')`
      const out = asOther(dir, script)
      const text = out.stdout.toString()
      expect(text).toContain('DATA:{"fresh":true}')
      expect(text).toContain('SAVED')
      expect(out.stderr.toString()).toContain('keptAs')
      const kept = readdirSync(dir).filter(n => n.startsWith('sessions.json.unreadable-'))
      expect(kept.length).toBe(1)
      const keptFile = join(dir, kept[0])
      expect(statSync(keptFile).mode & 0o777).toBe(0)
      chmodSync(keptFile, 0o600)
      expect(readFileSync(keptFile, 'utf8')).toBe('{"old":1}')
      expect(JSON.parse(readFileSync(f, 'utf8'))).toEqual({ fresh: true })
    } finally {
      for (const n of readdirSync(dir)) try { chmodSync(join(dir, n), 0o600) } catch { /* gone */ }
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('unreadable secret.key', () => {
  test('permission message, key file unchanged, no new key written', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fc-key-'))
    const data = join(dir, 'data')
    const f = join(data, 'secret.key')
    try {
      chmodSync(dir, 0o777)
      mkdirSync(data)
      chmodSync(data, 0o777)
      writeFileSync(f, 'b'.repeat(43))
      chmodSync(f, 0o000)
      const script = `import {seal} from ${JSON.stringify(join(root, 'src/secret-box.ts'))}
try { seal('x'); console.log('NOERROR') } catch (e) { console.log('ERR:' + e.message) }`
      const out = asOther(dir, script)
      const text = out.stdout.toString()
      expect(text).toContain('ERR:')
      expect(text).toContain('permission denied')
      expect(text).toContain('chown -R 1000:1000')
      expect(text).not.toContain('NOERROR')
      expect(statSync(f).mode & 0o777).toBe(0)
      expect(readdirSync(data).filter(n => n.includes('secret'))).toEqual(['secret.key'])
      chmodSync(f, 0o600)
      expect(readFileSync(f, 'utf8')).toBe('b'.repeat(43))
    } finally {
      try { chmodSync(f, 0o600) } catch { /* gone */ }
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
