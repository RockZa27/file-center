/**
 * A restore and the records of a later account that reused a name (security audit run 2). An account instance is
 * (lowercase username, createdAt): sessions, app passwords, share links, grants and group memberships of another
 * instance must not act as the restored account. The restore freezes the stores of its process, so the scenario
 * (tests/restore-scenario.ts) runs in a child process and is checked in a second one, the way the app restarts.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { dropRecordsOnDisk, planRestore } from '../src/account-records'

const script = resolve(import.meta.dir, 'restore-scenario.ts')
const base = mkdtempSync(join(tmpdir(), 'fc-restore-id-'))
afterAll(() => rmSync(base, { recursive: true, force: true }))

async function run(phase: string, mode: string, dir: string) {
  const env = { PATH: process.env.PATH!, HOME: process.env.HOME ?? base, TMPDIR: process.env.TMPDIR ?? tmpdir() }
  const p = Bun.spawn([process.execPath, script, phase, mode, dir], { env, stdout: 'pipe', stderr: 'pipe' })
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
  await p.exited
  const line = out.trim().split('\n').pop() ?? ''
  try { return JSON.parse(line) } catch { throw new Error(`${phase} ${mode} failed: ${out}\n${err}`) }
}

describe('restore with an account that reused a name', () => {
  test('a later same-name account: its session, app password, link, grants and group place do not act as the restored one', async () => {
    const dir = join(base, 'recreate')
    const setup = await run('setup', 'recreate', dir)
    expect(setup.statuses).toEqual({ ap: 200, share: 200, grant: 200, group: 200, member: 200, given: 200, received: 200 })
    const seen = await run('check', 'recreate', dir) // a fresh process: the restart
    expect(seen.sessionUser).toBeNull()
    expect(seen.dav).toBe(401)
    expect(seen.share).not.toBe(200)
    expect(seen.carolSees).toEqual([])
    expect(seen.groups).toEqual([])
    expect(seen.bobReceived).toEqual([])
    // the restored (first) account itself works with its own password
    expect(seen.firstPasswordLogin).toBe(200)
  }, 60_000)

  test('control: the account was not re-created, so its sessions, app passwords, links, grants and groups stay', async () => {
    const dir = join(base, 'control')
    expect((await run('setup', 'control', dir)).statuses.ap).toBe(200)
    const seen = await run('check', 'control', dir)
    expect(seen.sessionUser).toBe('bob')
    expect(seen.dav).toBe(200)
    expect(seen.share).toBe(200)
    expect(seen.carolSees).toEqual(['bob'])
    expect(seen.groups).toEqual(['team-x'])
    expect(seen.bobReceived).toEqual(['dora'])
  }, 60_000)
})

describe('planRestore: which names are proven to be the live account', () => {
  const at = '2026-01-01T00:00:00.000Z'
  test('same createdAt stays; another, none live, or none on a side is dropped; live-only names are dropped', () => {
    const live = [
      { username: 'Same', createdAt: at }, { username: 'moved', createdAt: '2026-02-01T00:00:00.000Z' },
      { username: 'nolive-date' }, { username: 'onlylive', createdAt: at }, { username: 'norestored-date', createdAt: at },
    ]
    const restored = [
      { username: 'same', createdAt: at }, { username: 'moved', createdAt: at }, { username: 'gone', createdAt: at },
      { username: 'nolive-date', createdAt: at }, { username: 'norestored-date' },
    ]
    const { same, drop } = planRestore(live, restored)
    expect([...same.keys()]).toEqual(['same'])
    expect([...drop].sort()).toEqual(['gone', 'moved', 'nolive-date', 'norestored-date', 'onlylive'])
  })

  test('a name twice in the backup is kept only when both entries are the live account', () => {
    const { same, drop } = planRestore([{ username: 'a', createdAt: at }], [{ username: 'a', createdAt: at }, { username: 'A', createdAt: 'x' }])
    expect(same.has('a')).toBe(false)
    expect(drop.has('a')).toBe(true)
  })
})

describe('dropRecordsOnDisk', () => {
  test('rewrites every identity-bound file for dropped names and leaves the others (and the files that are not there)', () => {
    const dir = join(base, 'files')
    mkdirSync(dir, { recursive: true })
    const paths = Object.fromEntries(['sessions', 'shares', 'userState', 'notifications', 'notifyState', 'guide', 'grants', 'appPasswords', 'groups'].map(k => [k, join(dir, `${k}.json`)])) as any
    {
        const now = Date.now()
        writeFileSync(paths.sessions, JSON.stringify({
          a: { username: 'Bob', created: now - 1000 }, b: { username: 'bob', created: now + 1000 }, c: { username: 'eve', created: now + 1000 },
          d: { username: null, created: 1 }, e: { username: 'kept', created: now + 1000 }, f: { username: 'kept', created: now - 100_000 },
        }))
        writeFileSync(paths.shares, JSON.stringify({ shares: [{ owner: 'BOB' }, { owner: 'kept' }, { owner: 'eve', revokedAt: 'x' }] }))
        writeFileSync(paths.userState, JSON.stringify({ bob: {}, kept: {} }))
        writeFileSync(paths.notifications, JSON.stringify({ Bob: [], kept: [] }))
        writeFileSync(paths.notifyState, JSON.stringify({ users: { bob: {}, kept: {} }, marks: {} }))
        writeFileSync(paths.guide, JSON.stringify({ users: { bob: {}, kept: {} } }))
        writeFileSync(paths.grants, JSON.stringify({ grants: [
          { owner: 'bob', to: 'kept' }, { owner: 'kept', to: 'Bob' }, { owner: 'kept', to: 'kept2' }, { owner: 'kept', to: 'bob', toGroup: true },
        ] }))
        writeFileSync(paths.appPasswords, JSON.stringify({ items: [{ username: 'bob' }, { username: 'kept' }] }))
        writeFileSync(paths.groups, JSON.stringify({ groups: [{ members: [{ username: 'BOB' }, { username: 'kept' }] }] }))
        dropRecordsOnDisk({ same: new Map([['kept', now]]), drop: new Set(['bob', 'eve']) }, paths)
        const read = (f: string) => JSON.parse(readFileSync(f, 'utf8'))
        expect(Object.keys(read(paths.sessions)).sort()).toEqual(['d', 'e'])
        expect(read(paths.shares).shares.map((s: any) => [s.owner, !!s.revokedAt])).toEqual([['BOB', true], ['kept', false], ['eve', true]])
        expect(Object.keys(read(paths.userState))).toEqual(['kept'])
        expect(Object.keys(read(paths.notifications))).toEqual(['kept'])
        expect(Object.keys(read(paths.notifyState).users)).toEqual(['kept'])
        expect(Object.keys(read(paths.guide).users)).toEqual(['kept'])
        expect(read(paths.grants).grants.map((g: any) => g.to)).toEqual(['kept2', 'bob'])
        expect(read(paths.appPasswords).items.map((p: any) => p.username)).toEqual(['kept'])
        expect(read(paths.groups).groups[0].members.map((m: any) => m.username)).toEqual(['kept'])
    }
  })
})
