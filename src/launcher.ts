/**
 * Starts the app and keeps it running. This is what `bun start` and the Docker image run.
 *
 * Why it exists: an update installed from the web needs the app restarted onto the new code without
 * anyone touching the server. The app asks for that by exiting with EXIT_RESTART. If a freshly installed
 * update does not come up healthy, the launcher goes back to the version that worked before. This file
 * is part of the image and is never replaced by a web update, so keep it small and boring.
 */
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { config, paths } from './config'
import { appendLine } from './logger'
import { text, type MessageCode, type Params } from './messages'
import {
  EXIT_RESTART, readManifest, readState, releasePath, releaseUsable, SERVER_FILE, writeState, compareVersions,
  type ReleaseState,
} from './release'

/** how long a new process has to answer /api/health (FC_HEALTH_TIMEOUT_MS; a big data folder or a slow disk may need more than the default 40 s) */
const HEALTH_TIMEOUT_MS = Number(process.env.FC_HEALTH_TIMEOUT_MS) || 40_000
/** an update must stay up this long after its first healthy answer to count as installed */
const STABLE_MS = Number(process.env.FC_STABLE_MS) || 8_000
/** stdout, and logs/launcher.log so the admin can download it from the web: the container's stdout is gone after a recreate */
function log(event: string, m: string, level: 'info' | 'warn' | 'error' = 'info') {
  console.log(`[launcher] ${m}`)
  appendLine(paths.launcherLog, JSON.stringify({ ts: new Date().toISOString(), level, event, detail: m }))
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
/** `last.message` stays Thai text for apps before 1.3.0; code + params let a newer app answer in the page's language */
const outcome = (code: MessageCode, params: Params = {}) => ({ message: text('th', code, params), code, params })

type Target = { name: string | null; version: string; cmd: string[]; env: Record<string, string> }

function chooseTarget(): Target {
  const state = readState(config.dataDir)
  const builtin: Target = {
    name: null, version: config.version, cmd: [process.execPath, join(config.root, 'src', 'index.ts')], env: {},
  }
  if (!state.current) return builtin
  const manifest = releaseUsable(config.dataDir, state.current) ? readManifest(releasePath(config.dataDir, state.current)) : null
  // a newer image (docker compose up --build) wins over an older installed update
  if (!manifest || compareVersions(manifest.version, config.version) <= 0) {
    log('skip-update', `ข้ามอัปเดต ${state.current}: ${manifest ? 'ระบบในอิมเมจใหม่กว่าหรือเท่ากัน' : 'ไฟล์ไม่ครบ'} ใช้เวอร์ชัน ${config.version} ที่มากับระบบ`)
    writeState(config.dataDir, { ...state, current: null, pending: null })
    return builtin
  }
  const dir = releasePath(config.dataDir, state.current)
  return {
    name: state.current,
    version: manifest.version,
    cmd: [process.execPath, join(dir, SERVER_FILE)],
    env: { WEB_DIR: join(dir, 'web'), FC_VERSION: manifest.version },
  }
}

async function healthy(target: Target): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${config.port}/api/health`, { signal: AbortSignal.timeout(2000) })
    if (!res.ok) return false
    const body = (await res.json()) as { version?: string; release?: string | null }
    return body.version === target.version && (body.release ?? null) === target.name
  } catch {
    return false
  }
}

/**
 * An update that failed: go back to what ran before and remember why. A release that crashed or exited is deleted.
 * One that only booted too slowly (`keepRelease`) stays installed and is put first in the history: the admin can switch
 * to it again from the update page (a bigger FC_HEALTH_TIMEOUT_MS first) without uploading the package again; the
 * usual retention (the two newest of the history) removes it later.
 */
function rollBack(state: ReleaseState, name: string, why: ReturnType<typeof outcome>, keepRelease = false) {
  const previous = state.pending?.dir === name ? state.pending.previous : null
  const version = readManifest(releasePath(config.dataDir, name))?.version ?? name
  const rest = state.history.filter(h => h !== name && h !== previous)
  writeState(config.dataDir, {
    ...state,
    current: previous && releaseUsable(config.dataDir, previous) ? previous : null,
    history: keepRelease ? [name, ...rest].slice(0, 2) : rest,
    pending: null,
    last: { dir: name, version, ok: false, ...why, at: new Date().toISOString() },
  })
  if (!keepRelease) rmSync(releasePath(config.dataDir, name), { recursive: true, force: true })
  log('rollback', `อัปเดต ${version} ใช้งานไม่ได้ (${why.message}) ย้อนกลับแล้ว${keepRelease ? ' (เก็บไฟล์เวอร์ชันนั้นไว้ให้ลองใหม่)' : ''}`, 'error')
}

let child: ReturnType<typeof Bun.spawn> | null = null
let stopping = false

async function main() {
  let crashes = 0
  while (!stopping) {
    const target = chooseTarget()
    log('start', `เริ่มระบบ v${target.version} (${target.name ? `อัปเดต ${target.name}` : 'เวอร์ชันที่มากับระบบ'})`)
    const startedAt = Date.now()
    child = Bun.spawn(target.cmd, {
      stdio: ['inherit', 'inherit', 'inherit'],
      env: { ...process.env, ...target.env, FC_SUPERVISED: '1', FC_RELEASE: target.name ?? '', FC_BUILTIN_VERSION: config.version },
    })

    let exited = false
    let timedOut = false
    const watch = (async () => {
      while (!exited && Date.now() - startedAt < HEALTH_TIMEOUT_MS) {
        if (await healthy(target)) {
          await sleep(STABLE_MS)
          if (exited) return
          const state = readState(config.dataDir)
          if (state.pending?.dir === target.name) {
            const version = readManifest(releasePath(config.dataDir, target.name))?.version ?? target.version
            writeState(config.dataDir, { ...state, pending: null, last: { dir: target.name, version, ok: true, ...outcome('update.installed'), at: new Date().toISOString() } })
            log('update-ok', `อัปเดต ${version} ทำงานปกติแล้ว`)
          }
          return
        }
        await sleep(500)
      }
      if (!exited) {
        timedOut = true
        log('unresponsive', `ระบบไม่ตอบสนองภายใน ${HEALTH_TIMEOUT_MS / 1000} วินาที (FC_HEALTH_TIMEOUT_MS) หยุดโปรเซส`, 'error')
        child?.kill()
      }
    })()

    const code = await child.exited
    exited = true
    await watch
    if (stopping) return code

    const state = readState(config.dataDir)
    const pendingNow = target.name !== null && state.pending?.dir === target.name
    if (code === EXIT_RESTART) {
      log('restart', 'ระบบขอรีสตาร์ต (อัปเดต กู้คืนข้อมูล หรือย้อนเวอร์ชัน)')
      crashes = 0
      continue
    }
    if (pendingNow) {
      // never answered, or fell over before it was confirmed
      // too slow to answer is not the same as broken: that release stays installed, so a retry needs no new upload
      if (timedOut) rollBack(state, target.name!, outcome('update.health-timeout', { seconds: Math.round(HEALTH_TIMEOUT_MS / 1000) }), true)
      else rollBack(state, target.name!, outcome('update.exited-unconfirmed', { exit: code }))
      continue
    }
    // a running version that crashes later is restarted as it is: rolling back could hide a mistake in .env or the disk
    crashes = Date.now() - startedAt > 60_000 ? 0 : crashes + 1
    const wait = Math.min(30_000, 1000 * 2 ** Math.min(crashes, 5))
    log('crash', `ระบบหยุดทำงาน (code ${code}) เริ่มใหม่ใน ${wait / 1000} วินาที`, 'error')
    await sleep(wait)
  }
  return 0
}

function stop(signal: NodeJS.Signals) {
  if (stopping) return
  stopping = true
  child?.kill(signal)
  // the app flushes its files within 8 s; the launcher does not wait forever
  setTimeout(() => { child?.kill('SIGKILL'); process.exit(0) }, 12_000).unref()
}
process.on('SIGTERM', () => stop('SIGTERM'))
process.on('SIGINT', () => stop('SIGINT'))

process.exit((await main()) ?? 0)
