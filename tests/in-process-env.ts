/**
 * `bun test` runs every test file in one process and they share modules: the first file that imports src/index
 * fixes the folders and limits of the app for all of them. Every test file that runs the app in-process imports
 * this module first (before src/index), so they agree on one setup whichever file runs first.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const base = mkdtempSync(join(tmpdir(), 'fc-test-'))
// shared by every file of the run, so it may only go once all of them are done: tests/preload.ts removes it then
// (a run of the suite left ~16 MB behind otherwise). bun test runs no exit handlers, hence the global hook.
;(globalThis as any).__fcTestBase = base
process.env.STORAGE_DIR = join(base, 'storage')
process.env.DATA_DIR = join(base, 'data')
process.env.ADMIN_PASSWORD = 'test-admin-pass'
process.env.UPLOAD_CHUNK_SIZE = String(1024 * 1024) // 1 MB chunks keep the test fast
process.env.LOGIN_MAX_ATTEMPTS = '3'
