import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { Elysia, t } from 'elysia'
import { audit, queryAudit } from '../audit'
import type { Perm } from '../settings'
import {
  allUsers, canManage, checkPasswordStrength, cleanHomedir, cleanPerms, confirmPassword, defaultHome, destroyUserSessions,
  dropLoginTickets, findUser, hashPassword, homeIsTaken, isAdmin, isReservedUsername, listUserSessions, publicUser, saveUsers, USERNAME_RE,
} from '../auth'
import { staleAfterMs, statusIn } from '../backup'
import { config, paths } from '../config'
import { context, manageable, requireAdmin, requireStaff } from '../context'
import { bad, conflict, ensureDir, forbidden, HttpError, isDir, listDirAsync, normRel, notFound, resolveIn } from '../fsx'
import { errorsSince } from '../logger'
import { langOf, type MessageCode, type Params, text } from '../messages'
import type { User } from '../auth'
import { cleanQuota, forget, usage } from '../quota'
import { settings } from '../settings'
import { forgetNotifications } from '../notify'
import { revokeSharesOf } from '../shares'
import { DISK_CRITICAL_PERCENT, DISK_LOW_PERCENT, diskInfo, storageStats } from '../stats'
import { removeUserState } from '../favorites'
import { removeGrantsOf } from '../grants'
import { listTrash, purge, restore, trashSummary } from '../trash'
import { isBeta } from '../release'
import { availableVersion } from '../update-source'
import { uploadsInProgress } from '../uploads'
import { alertRoutes } from './alerts'

const startedAt = Date.now()
const roleT = t.Union([t.Literal('admin'), t.Literal('manager'), t.Literal('user')])
const permsT = t.Array(t.String(), { maxItems: 50 })

function adminCount() {
  return allUsers().filter(u => u.role === 'admin').length
}

/**
 * A manager grants only what stays inside their own rights: home permissions as they like, but in the shared public
 * folder nothing they do not hold themself (an unchanged value the target already has is no escalation)
 */
function checkPublicPerms(actor: User, wanted: Perm[], already: Perm[] = []) {
  if (isAdmin(actor)) return
  const mine = new Set(actor.publicPermissions)
  if (wanted.some(p => !mine.has(p) && !already.includes(p))) throw forbidden('admin.public-perms-exceed')
}

export const adminRoutes = new Elysia({ prefix: '/api' })
  .use(context)
  // /api/admin/alerts: mounted here so the app's route list in index.ts stays as it is
  .use(alertRoutes)

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
  // staff see everyone; `manageable` tells the page which rows the caller may change (a manager: plain users only)
  .get('/admin/users', ({ user, ip }) => {
    const actor = requireStaff({ user, ip })
    // a manager gets name and role of the others, nothing else: folder, rights, quota and 2FA state are for those they manage
    return {
      users: allUsers().map(u => {
        const manageable = canManage(actor, u)
        return manageable || isAdmin(actor)
          ? { ...publicUser(u), manageable }
          : { username: u.username, name: u.name, role: u.role, manageable }
      }),
    }
  })

  .post('/admin/users', async ({ user, ip, body }) => {
    const admin = requireStaff({ user, ip })
    // a manager makes plain users only, always in /users/<name>, with public rights no wider than their own
    if (!isAdmin(admin) && body.role !== 'user') throw forbidden('admin.role-not-allowed')
    const username = body.username.trim()
    if (!USERNAME_RE.test(username)) throw bad('admin.bad-username')
    if (isReservedUsername(username)) throw bad('admin.reserved-username')
    if (findUser(username)) throw conflict('admin.username-taken')
    checkPasswordStrength(body.password, username)
    const name = body.name.trim()
    if (!name || name.length > 60) throw bad('admin.display-name-required')
    const homedir = body.role === 'admin' ? '/' : isAdmin(admin) ? cleanHomedir(body.homedir, username) : defaultHome(username)
    if (body.role !== 'admin' && homedir === '/') throw bad('admin.home-required')
    const publicPermissions = cleanPerms(body.publicPermissions)
    checkPublicPerms(admin, publicPermissions)
    // a manager never takes over a folder that is there already (an admin's shared folder, a deleted user's leftovers)
    if (!isAdmin(admin) && homeIsTaken(username)) throw conflict('admin.home-exists')
    ensureDir(resolveIn(config.storageDir, homedir))
    const quotaBytes = body.quotaBytes === undefined ? 0 : cleanQuota(body.quotaBytes)
    allUsers().push({
      username, name, role: body.role, homedir,
      ...(quotaBytes ? { quotaBytes } : {}),
      permissions: cleanPerms(body.permissions),
      publicPermissions,
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
      quotaBytes: t.Optional(t.Number()),
    }),
  })

  .put('/admin/users/:username', async ({ user, ip, params, body }) => {
    const admin = requireStaff({ user, ip })
    const target = manageable(admin, params.username)
    if (!isAdmin(admin) && body.role !== undefined && body.role !== 'user') throw forbidden('admin.role-not-allowed')
    // check every field first: a refused request must not leave half of its changes behind
    if (body.role && body.role !== target.role && target.role === 'admin' && adminCount() <= 1) {
      throw bad('admin.last-admin')
    }
    const name = body.name?.trim()
    if (name !== undefined && (!name || name.length > 60)) throw bad('admin.bad-display-name')
    const role = body.role ?? target.role
    let homedir = role === 'admin' ? '/' : target.homedir
    // a manager can not move anyone: the folder of a user they manage is /users/<name> already (canManage)
    if (isAdmin(admin) && role !== 'admin' && (body.homedir !== undefined || target.homedir === '/')) {
      homedir = cleanHomedir(body.homedir, target.username)
      if (homedir === '/') throw bad('admin.home-required')
    }
    const homeAbs = resolveIn(config.storageDir, homedir)
    if (body.password) checkPasswordStrength(body.password, target.username)
    const passwordHash = body.password ? await hashPassword(body.password) : null
    const quotaBytes = body.quotaBytes === undefined ? undefined : cleanQuota(body.quotaBytes)
    const publicPermissions = body.publicPermissions ? cleanPerms(body.publicPermissions) : undefined
    if (publicPermissions) checkPublicPerms(admin, publicPermissions, target.publicPermissions)
    // a manager who sets someone's password could sign in as them (past read-only and the view audit): own password first
    const reset = !!passwordHash && !isAdmin(admin)
    if (reset) await confirmPassword(admin, ip, body.confirmPassword ?? '', 'user-password-reset-denied')

    ensureDir(homeAbs)
    if (name !== undefined) target.name = name
    target.role = role
    target.homedir = homedir
    if (body.permissions) target.permissions = cleanPerms(body.permissions)
    if (publicPermissions) target.publicPermissions = publicPermissions
    if (quotaBytes !== undefined) {
      if (quotaBytes) target.quotaBytes = quotaBytes
      else delete target.quotaBytes
    }
    // a new limit or home folder: the old count says nothing about it
    forget(target.username)
    if (passwordHash) {
      target.passwordHash = passwordHash
      target.mustChangePassword = reset
      destroyUserSessions(target.username)
    }
    saveUsers()
    audit({ user: admin.username, ip, action: reset ? 'user-password-reset' : 'user-update', target: target.username })
    return { ok: true }
  }, {
    body: t.Object({
      name: t.Optional(t.String()), password: t.Optional(t.String()), confirmPassword: t.Optional(t.String({ maxLength: 1000 })), role: t.Optional(roleT),
      homedir: t.Optional(t.String()), permissions: t.Optional(permsT), publicPermissions: t.Optional(permsT),
      quotaBytes: t.Optional(t.Number()),
    }),
  })

  .delete('/admin/users/:username', ({ user, ip, params }) => {
    const admin = requireStaff({ user, ip })
    const target = manageable(admin, params.username)
    if (target.username === admin.username) throw bad('admin.delete-self')
    if (target.role === 'admin' && adminCount() <= 1) throw bad('admin.last-admin')
    const list = allUsers()
    list.splice(list.indexOf(target), 1)
    saveUsers()
    destroyUserSessions(target.username)
    revokeSharesOf(target.username)
    removeUserState(target.username)
    forgetNotifications(target.username)
    removeGrantsOf(target.username)
    audit({ user: admin.username, ip, action: 'user-delete', target: target.username })
    return { ok: true }
  })

  // a user's signed-in devices, and ending them all (a lost phone, a stolen cookie)
  .get('/admin/users/:username/sessions', ({ user, ip, params }) => {
    const target = manageable(requireStaff({ user, ip }), params.username)
    return { sessions: listUserSessions(target.username) }
  })

  .post('/admin/users/:username/sessions/revoke', ({ user, ip, params }) => {
    const admin = requireStaff({ user, ip })
    const target = manageable(admin, params.username)
    const revoked = destroyUserSessions(target.username)
    audit({ user: admin.username, ip, action: 'sessions-revoke', target: target.username, detail: String(revoked) })
    return { ok: true, revoked }
  })

  // for a user who lost the phone and the backup codes; the admin proves it is them with their own password
  .post('/admin/users/:username/2fa/reset', async ({ user, ip, params, body }) => {
    const admin = requireStaff({ user, ip })
    const target = manageable(admin, params.username)
    await confirmPassword(admin, ip, body.password, '2fa-reset-denied')
    delete target.twoFactor
    saveUsers()
    dropLoginTickets(target.username)
    destroyUserSessions(target.username)
    audit({ user: admin.username, ip, action: '2fa-reset', target: target.username })
    return { ok: true }
  }, { body: t.Object({ password: t.String({ maxLength: 1000 }) }) })

  // folder tree for the "home folder" picker
  .get('/admin/folders', async ({ user, ip, query }) => {
    requireAdmin({ user, ip })
    const rel = normRel(query.path)
    const abs = resolveIn(config.storageDir, rel)
    if (!isDir(abs)) throw notFound()
    return { path: rel, entries: (await listDirAsync(abs, rel)).filter(e => e.type === 'dir') }
  }, { query: t.Object({ path: t.Optional(t.String()) }) })

  // ───────────── dashboard ─────────────
  .get('/admin/status', ({ user, ip, request }) => {
    const actor = requireStaff({ user, ip })
    if (!isAdmin(actor)) {
      // a manager's dashboard: how many people and how much their homes hold. No version, uptime, disk, backup, trash or
      // update information (system internals stay with the admin), and the password warning counts only their own users
      const lang = langOf(request)
      const mine = allUsers().filter(u => canManage(actor, u))
      const warnings: { level: 'warning'; code: MessageCode; message: string; params: Params }[] = []
      if (mine.some(u => u.mustChangePassword)) {
        warnings.push({ level: 'warning', code: 'admin.default-password', message: text(lang, 'admin.default-password'), params: {} })
      }
      // the homes of the users they manage only (their quota counts, so no file count): never the totals of the whole storage
      const counts = mine.map(usage)
      return {
        reduced: true,
        users: mine.length,
        storage: { size: counts.reduce((n, c) => n + c.used, 0) },
        stale: counts.some(c => c.counting),
        warnings,
      }
    }
    const disk = diskInfo()
    // one code per message, the text in the admin's language
    const lang = langOf(request)
    const backup = statusIn(lang)
    const trash = trashSummary()
    const warnings: { level: 'info' | 'warning' | 'critical'; code: MessageCode; message: string; params: Params }[] = []
    const warn = (level: 'info' | 'warning' | 'critical', code: MessageCode, params: Params = {}) =>
      warnings.push({ level, code, message: text(lang, code, params), params })
    if (disk) {
      const freePct = (disk.free / disk.total) * 100
      if (freePct < DISK_CRITICAL_PERCENT) warn('critical', 'admin.disk-critical', { percent: freePct.toFixed(1) })
      else if (freePct < DISK_LOW_PERCENT) warn('warning', 'admin.disk-low', { percent: freePct.toFixed(1) })
    }
    if (!backup) warn('info', 'backup.never')
    else if (backup.status === 'failed') warn('critical', 'backup.last-failed')
    else if (backup.lastSuccess && Date.now() - Date.parse(backup.lastSuccess) > staleAfterMs()) warn('warning', 'backup.stale', { days: Math.ceil(staleAfterMs() / 86400_000) })
    if (allUsers().some(u => u.mustChangePassword)) warn('warning', 'admin.default-password')
    const errors = errorsSince(Date.now() - 24 * 3600_000)
    if (errors) warn('warning', 'errors', { count: errors })
    if (config.updateAllowUnsigned) warn('warning', 'update.allow-unsigned')
    if (isBeta(config.version)) warn('warning', 'update.on-beta', { version: config.version })
    // found by the daily look at UPDATE_SOURCE (alerts.ts)
    const newer = availableVersion()
    if (newer) warn('info', 'update.available', { version: newer })
    return {
      reduced: false,
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

  // a manager sees what they and the users they manage did
  .get('/admin/activity', ({ user, ip, query }) => {
    const actor = requireStaff({ user, ip })
    const names = isAdmin(actor) ? null : new Set([actor.username, ...allUsers().filter(u => canManage(actor, u)).map(u => u.username)])
    return queryAudit({
      only: names ? r => names.has(r.user) : undefined,
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

  .post('/admin/trash/restore', async ({ user, ip, body }) => {
    const admin = requireAdmin({ user, ip })
    const r = await restore(body.id)
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
