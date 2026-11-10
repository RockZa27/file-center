/**
 * Retention of the logs (src/log-retention.ts): AUDIT_RETENTION_DAYS / LOG_RETENTION_DAYS. The sweep is pointed at files in
 * this test's own temp folder, never at the real logs other test files read.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseRetentionDays } from '../src/config'
import { appendLine, readNewestFirst } from '../src/logger'
import { resetLogRetentionClock, runLogRetention, sweepFamilies, type LogFamily } from '../src/log-retention'

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.parse('2030-06-01T12:00:00Z')
const dir = mkdtempSync(join(tmpdir(), 'fc-logret-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** a line `daysAgo` days before NOW */
const at = (daysAgo: number, n: string) => JSON.stringify({ ts: new Date(NOW - daysAgo * DAY).toISOString(), action: n })
const write = (f: string, lines: string[]) => writeFileSync(f, lines.join('\n') + '\n')
const read = (f: string) => readFileSync(f, 'utf8').split('\n').filter(Boolean)
const actions = (f: string) => read(f).map(l => { try { return JSON.parse(l).action ?? 'nots' } catch { return l } })

let n = 0
let file: string
let fam: LogFamily
beforeEach(() => {
  file = join(dir, `audit-${++n}.log`)
  fam = { name: 'audit', file, maxFiles: 4, days: 30 }
  resetLogRetentionClock()
})

describe('sweepFamilies', () => {
  test('deletes old rotated files, rewrites a straddling one, trims the current file, keeps undated and broken lines', () => {
    write(`${file}.2`, [at(90, 'a'), at(80, 'b')])
    write(`${file}.1`, [at(60, 'c'), at(40, 'd'), at(20, 'e'), at(10, 'f')])
    write(file, [at(50, 'g'), 'not json', JSON.stringify({ action: 'nodate' }), JSON.stringify({ ts: 'garbage', action: 'badts' }), at(5, 'h'), at(1, 'i')])
    const out = sweepFamilies([fam], NOW)
    expect(existsSync(`${file}.2`)).toBe(false)
    expect(actions(`${file}.1`)).toEqual(['e', 'f'])
    expect(actions(file)).toEqual(['not json', 'nodate', 'badts', 'h', 'i'])
    expect(out).toEqual([{ name: 'audit', lines: 2 + 2 + 1, files: 1 }])
  })

  test('a file whose first line is inside the window is not parsed further (lines are in time order)', () => {
    // a line out of order after a dated new first line is not looked at: the file is judged by its head
    write(file, [at(5, 'x'), at(40, 'out-of-order'), at(4, 'y')])
    const before = statSync(file)
    expect(sweepFamilies([fam], NOW)).toEqual([])
    expect(statSync(file).ino).toBe(before.ino)
    expect(actions(file)).toEqual(['x', 'out-of-order', 'y'])
  })

  test('a rotated file with only undated lines is not deleted', () => {
    write(`${file}.1`, ['broken', JSON.stringify({ x: 1 })])
    expect(sweepFamilies([fam], NOW)).toEqual([])
    expect(read(`${file}.1`).length).toBe(2)
  })

  test('a current file with only old lines is emptied, not removed', () => {
    write(file, [at(99, 'a')])
    sweepFamilies([fam], NOW)
    expect(existsSync(file)).toBe(true)
    expect(read(file)).toEqual([])
  })

  test('off (0 days): nothing changes', () => {
    const lines = [at(900, 'a'), at(1, 'b')]
    write(file, lines)
    write(`${file}.1`, [at(800, 'c')])
    expect(sweepFamilies([{ ...fam, days: 0 }], NOW)).toEqual([])
    expect(read(file)).toEqual(lines)
    expect(existsSync(`${file}.1`)).toBe(true)
  })

  test('the rewritten file keeps its mode', () => {
    write(file, [at(90, 'a'), at(1, 'b')])
    chmodSync(file, 0o600)
    sweepFamilies([fam], NOW)
    expect(actions(file)).toEqual(['b'])
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  test('appending still works after the sweep, and rotation works with gaps in the numbering', () => {
    write(`${file}.3`, [at(1, 'keep3')])
    write(`${file}.2`, [at(90, 'old2')])
    write(`${file}.1`, [at(90, 'old1')])
    write(file, [at(90, 'old0'), at(2, 'k')])
    sweepFamilies([fam], NOW)
    expect([1, 2].map(i => existsSync(`${file}.${i}`))).toEqual([false, false])
    appendLine(file, at(0, 'new'), 1e9, 4)
    expect(actions(file)).toEqual(['k', 'new'])
    // rotate (size >= 1 byte): the gap does not break it, .3 is the oldest slot and is replaced
    appendLine(file, at(0, 'after'), 1, 4)
    expect(actions(`${file}.1`)).toEqual(['k', 'new'])
    expect(actions(file)).toEqual(['after'])
    expect(existsSync(`${file}.3`)).toBe(false)
    expect([...readNewestFirst<{ action: string }>(file, 4)].map(e => e.action)).toEqual(['after', 'new', 'k'])
  })

  test('families are swept by their own days', () => {
    const other = join(dir, `sys-${n}.log`)
    write(file, [at(40, 'a'), at(1, 'b')])
    write(other, [at(40, 'a'), at(1, 'b')])
    sweepFamilies([fam, { name: 'system', file: other, maxFiles: 2, days: 90 }], NOW)
    expect(actions(file)).toEqual(['b'])
    expect(actions(other)).toEqual(['a', 'b'])
  })
})

describe('runLogRetention', () => {
  test('runs at most once a day', () => {
    write(file, [at(90, 'a'), at(1, 'b')])
    expect(runLogRetention(NOW, [fam])).toEqual([{ name: 'audit', lines: 1, files: 0 }])
    write(file, [at(90, 'c'), at(1, 'd')])
    expect(runLogRetention(NOW + 3600_000, [fam])).toBeNull()
    expect(actions(file)).toEqual(['c', 'd'])
    expect(runLogRetention(NOW + DAY + 1, [fam])).not.toBeNull()
    expect(actions(file)).toEqual(['d'])
  })
})

describe('parseRetentionDays', () => {
  test('a positive whole number is taken; unset and empty are off; anything else is 0 with the text kept for a warning', () => {
    expect(parseRetentionDays(undefined)).toEqual({ days: 0, invalid: '' })
    expect(parseRetentionDays('  ')).toEqual({ days: 0, invalid: '' })
    expect(parseRetentionDays(' 365 ')).toEqual({ days: 365, invalid: '' })
    expect(parseRetentionDays('0')).toEqual({ days: 0, invalid: '' })
    for (const bad of ['-5', '1.5', 'abc', '30d', '1e3']) expect(parseRetentionDays(bad)).toEqual({ days: 0, invalid: bad })
  })
})
