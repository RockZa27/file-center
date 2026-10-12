import { existsSync, readFileSync, rmSync, statfsSync } from 'node:fs'
import { join } from 'node:path'
import { Elysia, t } from 'elysia'
import { audit, queryAudit } from '../audit'
import {
  allUsers, checkPasswordStrength, cleanHomedir, cleanPerms, destroyUserSessions, findUser, hashPassword,
  isReservedUsername, publicUser, saveUsers, USERNAME_RE,
} from '../auth'
import { config, paths } from '../config'
import { context, requireAdmin } from '../context'
import { bad, conflict, ensureDir, forbidden, HttpError, isDir, listDir, normRel, notFound, resolveIn } from '../fsx'
import { errorsSince } from '../logger'
import { langOf, type MessageCode, type Params, text } from '../messages'
import { settings } from '../settings'
import { revokeSharesOf } from '../shares'
import { storageStats } from '../stats'
import { listTrash, purge, restore, trashSummary } from '../trash'
import { uploadsInProgress } from '../uploads'

const startedAt = Date.now()
const roleT = t.Union([t.Literal('admin'), t.Literal('user')])
const permsT = t.Array(t.String())

function diskInfo() {
  try {
    const s = statfsSync(config.storageDir)
    const total = Number(s.blocks) * Number(s.bsize)
    const free = Number(s.bavail) * Number(s.bsize)
    return { total, free, used: total - free }
  } catch {
    return null
  }
}

function backupInfo() {
  try {
    if (!existsSync(paths.backupStatus)) return null
    return JSON.parse(readFileSync(paths.backupStatus, 'utf8'))
  } catch {
    return null
  }
}

function adminCount() {
  return allUsers().filter(u => u.role === 'admin').length
}

export const adminRoutes = new Elysia({ prefix: '/api' })
  .use(context)

  // ───────────── public branding ─────────────
  .get('/branding/logo', () => {
    const logo = settings.get().logo
    if (!logo) throw notFound()
    const ext = logo.split(':')[0]
    const file = Bun.file(join(paths.branding, `logo.${ext}`))
    return new Response(file, {
      headers: {
        'Content-Type': ext === 'svg' ? 'image/svg+xml' : file.type,
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    })
  })

  // ───────────── users ─────────────
  .get('/admin/users', ({ user, ip }) => {
    requireAdmin({ user, ip })
    return { users: allUsers().map(publicUser) }
  })

  .post('/admin/users', async ({ user, ip, body }) => {
    const admin = requireAdmin({ user, ip })
    const username = body.username.trim()
    if (!USERNAME_RE.test(username)) throw bad('admin.bad-username')
    if (isReservedUsername(username)) throw bad('admin.reserved-username')
    if (findUser(username)) throw conflict('admin.username-taken')
    checkPasswordStrength(body.password, username)
    const name = body.name.trim()
    if (!name || name.length > 60) throw bad('admin.display-name-required')
    const homedir = body.role === 'admin' ? '/' : cleanHomedir(body.homedir, username)
    if (body.role !== 'admin' && homedir === '/') throw bad('admin.home-required')
    ensureDir(resolveIn(config.storageDir, homedir))
    allUsers().push({
      username, name, role: body.role, homedir,
      permissions: cleanPerms(body.permissions),
      publicPermissions: cleanPerms(body.publicPermissions),
      passwordHash: await hashPassword(body.password),
      createdAt: new Date().toISOString(),
    })
    saveUsers()
    audit({ user: admin.username, ip, action: 'user-create', target: username })
    return { ok: true }
  }, {
    body: t.Object({
      username: t.String(), name: t.String(), password: t.String(), role: roleT,
      homedir: t.Optional(t.String()), permissions: permsT, publicPermissions: permsT,
    }),
  })

  .put('/admin/users/:username', async ({ user, ip, params, body }) => {
    const admin = requireAdmin({ user, ip })
    const target = findUser(params.username)
    if (!target) throw notFound('admin.user-not-found')
    // check every field first: a refused request must not leave half of its changes behind
    if (body.role && body.role !== target.role && target.role === 'admin' && adminCount() <= 1) {
      throw bad('admin.last-admin')
    }
    const name = body.name?.trim()
    if (name !== undefined && (!name || name.length > 60)) throw bad('admin.bad-display-name')
    const role = body.role ?? target.role
    let homedir = role === 'admin' ? '/' : target.homedir
    if (role !== 'admin' && (body.homedir !== undefined || target.homedir === '/')) {
      homedir = cleanHomedir(body.homedir, target.username)
      if (homedir === '/') throw bad('admin.home-required')
    }
    const homeAbs = resolveIn(config.storageDir, homedir)
    if (body.password) checkPasswordStrength(body.password, target.username)
    const passwordHash = body.password ? await hashPassword(body.password) : null

    ensureDir(homeAbs)
    if (name !== undefined) target.name = name
    target.role = role
    target.homedir = homedir
    if (body.permissions) target.permissions = cleanPerms(body.permissions)
    if (body.publicPermissions) target.publicPermissions = cleanPerms(body.publicPermissions)
    if (passwordHash) {
      target.passwordHash = passwordHash
      target.mustChangePassword = false
      destroyUserSessions(target.username)
    }
    saveUsers()
    audit({ user: admin.username, ip, action: 'user-update', target: target.username })
    return { ok: true }
  }, {
    body: t.Object({
      name: t.Optional(t.String()), password: t.Optional(t.String()), role: t.Optional(roleT),
      homedir: t.Optional(t.String()), permissions: t.Optional(permsT), publicPermissions: t.Optional(permsT),
    }),
  })

  .delete('/admin/users/:username', ({ user, ip, params }) => {
    const admin = requireAdmin({ user, ip })
    const target = findUser(params.username)
    if (!target) throw notFound('admin.user-not-found')
    if (target.username === admin.username) throw bad('admin.delete-self')
    if (target.role === 'admin' && adminCount() <= 1) throw bad('admin.last-admin')
    const list = allUsers()
    list.splice(list.indexOf(target), 1)
    saveUsers()
    destroyUserSessions(target.username)
    revokeSharesOf(target.username)
    audit({ user: admin.username, ip, action: 'user-delete', target: target.username })
    return { ok: true }
  })

  // folder tree for the "home folder" picker
  .get('/admin/folders', ({ user, ip, query }) => {
    requireAdmin({ user, ip })
    const rel = normRel(query.path)
    const abs = resolveIn(config.storageDir, rel)
    if (!isDir(abs)) throw notFound()
    return { path: rel, entries: listDir(abs, rel).filter(e => e.type === 'dir') }
  }, { query: t.Object({ path: t.Optional(t.String()) }) })

  // ───────────── dashboard ─────────────
  .get('/admin/status', ({ user, ip, request }) => {
    requireAdmin({ user, ip })
    const disk = diskInfo()
    const backup = backupInfo()
    const trash = trashSummary()
    // one code per message, the text in the admin's language
    const lang = langOf(request)
    const warnings: { level: 'info' | 'warning' | 'critical'; code: MessageCode; message: string; params: Params }[] = []
    const warn = (level: 'info' | 'warning' | 'critical', code: MessageCode, params: Params = {}) =>
      warnings.push({ level, code, message: text(lang, code, params), params })
    if (disk) {
      const freePct = (disk.free / disk.total) * 100
      if (freePct < 5) warn('critical', 'admin.disk-critical', { percent: freePct.toFixed(1) })
      else if (freePct < 10) warn('warning', 'admin.disk-low', { percent: freePct.toFixed(1) })
    }
    if (!backup) warn('info', 'backup.never')
    else if (backup.status === 'failed') warn('critical', 'backup.last-failed')
    else if (backup.lastSuccess && Date.now() - Date.parse(backup.lastSuccess) > 48 * 3600_000) warn('warning', 'backup.stale', { days: 2 })
    if (allUsers().some(u => u.mustChangePassword)) warn('warning', 'admin.default-password')
    const errors = errorsSince(Date.now() - 24 * 3600_000)
    if (errors) warn('warning', 'errors', { count: errors })
    return {
      version: config.version,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      disk,
      ...storageStats(), // { storage, stale }: last numbers at once (null before the first count), recounted in the background
      trash,
      uploadsInProgress: uploadsInProgress(),
      users: allUsers().length,
      backup,
      warnings,
      runtime: `Bun ${Bun.version}`,
    }
  })

  .get('/admin/activity', ({ user, ip, query }) => {
    requireAdmin({ user, ip })
    return queryAudit({
      user: query.user || undefined,
      action: query.action || undefined,
      q: query.q || undefined,
      page: Math.max(1, Number(query.page) || 1),
      pageSize: Math.min(100, Math.max(5, Number(query.pageSize) || 25)),
    })
  }, {
    query: t.Object({
      user: t.Optional(t.String()), action: t.Optional(t.String()), q: t.Optional(t.String()),
      page: t.Optional(t.String()), pageSize: t.Optional(t.String()),
    }),
  })

  // ───────────── trash ─────────────
  .get('/admin/trash', ({ user, ip }) => {
    requireAdmin({ user, ip })
    return { items: listTrash(), retentionDays: config.trashRetentionDays }
  })

  .post('/admin/trash/restore', ({ user, ip, body }) => {
    const admin = requireAdmin({ user, ip })
    const r = restore(body.id)
    audit({ user: admin.username, ip, action: 'restore', target: r.restoredTo })
    return { ok: true, restoredTo: r.restoredTo }
  }, { body: t.Object({ id: t.String() }) })

  .post('/admin/trash/purge', ({ user, ip, body }) => {
    const admin = requireAdmin({ user, ip })
    const n = purge(body.id)
    audit({ user: admin.username, ip, action: 'purge', detail: `${n} รายการ` })
    return { ok: true, removed: n }
  }, { body: t.Object({ id: t.Optional(t.String()) }) })

  // ───────────── settings ─────────────
  .get('/admin/settings', ({ user, ip }) => {
    requireAdmin({ user, ip })
    return settings.get()
  })

  .put('/admin/settings', ({ user, ip, body }) => {
    const admin = requireAdmin({ user, ip })
    const patch: Record<string, unknown> = {}
    const text = (key: keyof typeof body, max: number, min = 0) => {
      const v = body[key]
      if (v === undefined) return
      const s = String(v).trim()
      if (s.length < min || s.length > max) throw bad('admin.text-length')
      patch[key] = s
    }
    text('appName', 60, 1)
    text('welcomeTitle', 120)
    text('welcomeText', 600)
    text('publicEmptyText', 300)
    if (body.primaryColor !== undefined) {
      if (!/^#[0-9a-fA-F]{6}$/.test(body.primaryColor)) throw bad('admin.bad-color')
      patch.primaryColor = body.primaryColor.toLowerCase()
    }
    if (body.publicEnabled !== undefined) patch.publicEnabled = body.publicEnabled
    if (body.guestPermissions) patch.guestPermissions = cleanPerms(body.guestPermissions)
    settings.update(patch)
    audit({ user: admin.username, ip, action: 'settings-update', detail: Object.keys(patch).join(', ') })
    return settings.get()
  }, {
    body: t.Object({
      appName: t.Optional(t.String()), primaryColor: t.Optional(t.String()),
      welcomeTitle: t.Optional(t.String()), welcomeText: t.Optional(t.String()),
      publicEmptyText: t.Optional(t.String()), publicEnabled: t.Optional(t.Boolean()),
      guestPermissions: t.Optional(permsT),
    }),
  })

  .put('/admin/logo', async ({ user, ip, request }) => {
    const admin = requireAdmin({ user, ip })
    const type = (request.headers.get('content-type') ?? '').split(';')[0].trim()
    const ext = ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/svg+xml': 'svg' } as Record<string, string>)[type]
    if (!ext) throw bad('admin.logo-type')
    const data = await request.arrayBuffer()
    if (data.byteLength === 0 || data.byteLength > 1024 * 1024) throw bad('admin.logo-size')
    const old = settings.get().logo
    if (old) rmSync(join(paths.branding, `logo.${old.split(':')[0]}`), { force: true })
    await Bun.write(join(paths.branding, `logo.${ext}`), data)
    settings.update({ logo: `${ext}:${Date.now()}` })
    audit({ user: admin.username, ip, action: 'logo-update' })
    return settings.get()
  }, { parse: 'none' })

  .delete('/admin/logo', ({ user, ip }) => {
    const admin = requireAdmin({ user, ip })
    const old = settings.get().logo
    if (old) rmSync(join(paths.branding, `logo.${old.split(':')[0]}`), { force: true })
    settings.update({ logo: null })
    audit({ user: admin.username, ip, action: 'logo-remove' })
    return settings.get()
  })

export { forbidden, HttpError }
