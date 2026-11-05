/**
 * Follow-ups to backup encryption: the plaintext restore temp must not linger in BACKUP_DIR, and the sidecar litter sweep
 * only touches names that are ours. Runs on its own backup folder (config.backupDir is swapped and put back).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import './in-process-env'

describe('backup folder litter', () => {
  let dir = ''
  let was = ''
  let backup: typeof import('../src/backup')
  const old = '.restore-0123456789ab.zip.tmp'
  const fresh = '.restore-ba9876543210.zip.tmp'
  const stale = (name: string) => {
    writeFileSync(join(dir, name), 'plain zip bytes')
    const t = new Date(Date.now() - 3600_000)
    utimesSync(join(dir, name), t, t)
  }

  beforeAll(async () => {
    await import('../src/index')
    const { config } = await import('../src/config')
    backup = await import('../src/backup')
    while (backup.backupRunning()) await Bun.sleep(50)
    was = config.backupDir
    dir = mkdtempSync(join(tmpdir(), 'fc-followup-'))
    config.backupDir = dir
  })
  beforeEach(async () => {
    while (backup.backupRunning()) await Bun.sleep(50)
    for (const n of readdirSync(dir)) rmSync(join(dir, n), { force: true })
  })
  afterAll(async () => {
    const { config } = await import('../src/config')
    config.backupDir = was
    rmSync(dir, { recursive: true, force: true })
  })

  test('a stale restore temp is gone after a backup run; a fresh one stays', async () => {
    stale(old)
    writeFileSync(join(dir, fresh), 'being written')
    await backup.runBackup()
    expect(existsSync(join(dir, old))).toBe(false)
    expect(existsSync(join(dir, fresh))).toBe(true)
  })

  test('housekeeping removes a stale restore temp, keeps a fresh one and anything else', () => {
    stale(old)
    writeFileSync(join(dir, fresh), 'being written')
    writeFileSync(join(dir, '.restore-notahex.zip.tmp'), 'x')
    writeFileSync(join(dir, 'mine.zip.tmp'), 'x')
    expect(backup.sweepRestoreTempsIdle()).toBe(1)
    expect(readdirSync(dir).sort()).toEqual([fresh, '.restore-notahex.zip.tmp', 'mine.zip.tmp'].sort())
  })

  test('housekeeping does nothing while a backup or restore is running', async () => {
    const running = backup.runBackup()
    expect(backup.backupRunning()).toBe(true)
    stale(old) // made after the backup's own sweep, so only housekeeping could remove it
    expect(backup.sweepRestoreTempsIdle()).toBe(0)
    expect(existsSync(join(dir, old))).toBe(true)
    await running
  })
})
