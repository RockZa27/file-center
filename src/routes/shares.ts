import { randomBytes } from 'node:crypto'
import { lstatSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { Elysia, t } from 'elysia'
import { alert } from '../alerts'
import { audit } from '../audit'
import { accessFor, canManage, clearFailures, findUser, hashPassword, lockedFor, recordFailure } from '../auth'
import { config } from '../config'
import { context, need, requireStaff, requireUser } from '../context'
import { bad, forbidden, HttpError, listDirAsync, normRel, notFound, resolveIn, storagePath, treeStats } from '../fsx'
import { sizeText } from '../messages'
import { nameOf, notify } from '../notify'
import { limitOf as quotaOf, ready } from '../quota'
import {
  allowedShareDays, allShares, createShare, findShare, isUnlocked, kindOf, lockoutKey, openShare, publicShare,
  recordUpload, revokeShare, type Share, SHARE_COOKIE, SHARE_LOCKOUT, SHARE_MAX_DOWNLOADS, SHARE_MAX_FILES,
  SHARE_MAX_TOTAL, SHARE_NOTE_MAX, SHARE_PASSWORD_MIN, SHARE_UPLOADS_PER_IP, SHARE_UPLOADS_PER_LINK, SHARES_PER_USER,
  sharesOf, shareTarget, shareToken, startDownload, stateOf, UNLOCK_MS, unlockCookie, uploadFull, uploadsBy
} from '../shares'
import { cancelUpload, checkUpload, completeUpload, initUpload, saveChunk, shareUploadLoad } from '../uploads'
import { collectZipItems, zipStream } from '../zip'
import { contentDisposition, fileResponse } from './files'

/** where the owner finds what arrived: the folder of an upload link in the file browser (a path in the app, no token) */
const filesLink = (s: Share) => `/files?${s.space === 'home' ? '' : `space=${encodeURIComponent(s.space)}&`}path=${encodeURIComponent(s.path)}`

/**
 * A place inside a shared folder. normRel refuses "..", resolveIn keeps it under the shared folder, and no step of the
 * way may be a link (a link inside the folder could point anywhere in the owner's space).
 */
function insideShare(root: string, input: unknown): { rel: string; abs: string } {
  const rel = normRel(input)
  const abs = resolveIn(root, rel)
  let at = root
  for (const seg of rel.split('/').filter(Boolean)) {
    at = join(at, seg)
    let st
    try { st = lstatSync(at) } catch { throw notFound() }
    if (st.isSymbolicLink()) throw notFound()
  }
  return { rel, abs }
}

/**
 * The file a path names inside a download link, found the way /api/s/:token/download finds it (same checks: the link
 * is live, its password given, no link on the way). Used by the routes that look at a file without downloading it.
 */
export function shareFile(token: unknown, path: unknown, request: Request): { share: Share; abs: string } {
  const { share, abs } = openShare(token, 'download')
  needUnlocked(share, request)
  let target = abs
  if (share.type === 'dir') target = insideShare(abs, path).abs
  else if (normRel(path) !== '/') throw notFound()
  let st
  try { st = lstatSync(target) } catch { throw notFound() }
  if (!st.isFile()) throw notFound()
  return { share, abs: target }
}

/** the link is there but has a password this browser has not given yet */
export function needUnlocked(share: Share, request: Request) {
  if (!isUnlocked(share, request)) throw new HttpError(401, 'share.password-required')
}

/**
 * Count a download once its last byte has been handed over; a cancelled download (or an error half way) only gives
 * its place back. Answers other than a whole file (206 parts, 416) never count.
 */
export function counted(res: Response, slot: { finish(): void; release(): void }): Response {
  if (res.status !== 200 || !res.body) {
    slot.release()
    return res
  }
  const reader = res.body.getReader()
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read()
        if (done) {
          slot.finish()
          controller.close()
        } else controller.enqueue(value)
      } catch (err) {
        slot.release()
        controller.error(err)
      }
    },
    cancel(reason) {
      slot.release()
      return reader.cancel(reason)
    },
  })
  return new Response(body, { status: res.status, headers: res.headers })
}

/**
 * A link without a download limit has nothing to protect by waiting for the last byte, so the answer goes out as it is
 * (Bun sends a file straight from disk) and the download is counted now: once for a whole file, never for 206 and 416.
 */
export function settled(res: Response, slot: { finish(): void; release(): void }): Response {
  if (res.status === 200 && res.body) slot.finish()
  else slot.release()
  return res
}

/** the browser of a visitor to an upload link, by a random key in a cookie that only that link's path receives */
export const VISITOR_COOKIE = 'fc_visitor'
const VISITOR_RE = /^[a-f0-9]{32}$/
const VISITOR_MAX_AGE_S = 24 * 3600

function visitorKey(request: Request): string | null {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const at = part.indexOf('=')
    if (at < 0 || part.slice(0, at).trim() !== VISITOR_COOKIE) continue
    const v = part.slice(at + 1).trim()
    return VISITOR_RE.test(v) ? v : null
  }
  return null
}

/** the link (open, of the upload kind, password given) and the owner name its uploads carry: tied to this link AND this visitor */
function visitorUpload(token: unknown, request: Request) {
  const { share, abs } = openShare(token, 'upload')
  needUnlocked(share, request)
  const key = visitorKey(request)
  if (!key) throw notFound('upload.not-found')
  return { share, abs, key, owner: `share:${share.id}:${key}` }
}

/** a limit given when the link is made: empty, or a whole number from 1 to `max` */
function limitOf(input: number | null | undefined, max: number): number | null {
  if (input === undefined || input === null) return null
  if (!Number.isSafeInteger(input) || input < 1 || input > max) {
    throw bad('share.bad-upload-limits', { file: config.uploadMaxSize, files: SHARE_MAX_FILES, total: SHARE_MAX_TOTAL })
  }
  return input
}

export const shareRoutes = new Elysia({ prefix: '/api' })
  .use(context)

  // ───────────── the owner's links ─────────────
  .post('/shares', async ({ user, ip, body }) => {
    // visitors never make links, whatever the guest permissions say
    const owner = requireUser({ user, ip })
    const kind = body.kind ?? 'download'
    const a = need({ user, ip }, body.space, 'share', kind === 'upload' ? 'upload' : 'download')
    const rel = normRel(body.path)
    if (rel === '/') throw bad('files.root-item')
    // links are made in an own space only (a staff view of someone's home has no `share` right anyway)
    if (a.space !== 'home' && a.space !== 'public') throw forbidden()
    const abs = resolveIn(a.root, rel)
    let st
    try { st = lstatSync(abs) } catch { throw notFound() }
    if (st.isSymbolicLink() || !(st.isFile() || st.isDirectory())) throw notFound()
    if (kind === 'upload' && !st.isDirectory()) throw bad('share.upload-folder-only')

    const days = allowedShareDays()
    if (!days.includes(body.days)) throw bad('share.bad-days', { days: days.join(', ') })
    const max = kind === 'upload' ? null : body.maxDownloads ?? null
    if (max !== null && (!Number.isInteger(max) || max < 1 || max > SHARE_MAX_DOWNLOADS)) {
      throw bad('share.bad-max-downloads', { max: SHARE_MAX_DOWNLOADS })
    }
    const password = body.password || null
    if (password !== null && password.length < SHARE_PASSWORD_MIN) throw bad('share.password-too-short', { min: SHARE_PASSWORD_MIN })
    if (password !== null && password.length > 200) throw bad('auth.password-too-long')
    if (sharesOf(owner.username).length >= SHARES_PER_USER) throw bad('share.too-many', { max: SHARES_PER_USER })
    // upload links only: what the visitor may send, and a note that is shown as plain text
    const note = (body.note ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim()
    if (Array.from(note).length > SHARE_NOTE_MAX) throw bad('share.note-too-long', { max: SHARE_NOTE_MAX })
    const upload = kind === 'upload' ? {
      kind: 'upload' as const,
      maxFileBytes: limitOf(body.maxFileBytes, config.uploadMaxSize),
      maxFiles: limitOf(body.maxFiles, SHARE_MAX_FILES),
      maxTotalBytes: limitOf(body.maxTotalBytes, SHARE_MAX_TOTAL),
      note,
    } : {}

    const { share, token } = createShare({
      owner: owner.username,
      space: a.space,
      path: rel,
      type: st.isDirectory() ? 'dir' : 'file',
      expiresAt: new Date(Date.now() + body.days * 86_400_000).toISOString(),
      maxDownloads: max,
      ...upload,
      ...(password ? { passwordHash: await hashPassword(password) } : {}),
    })
    // the path, never the token
    audit({
      user: owner.username, ip, action: 'share-create', target: storagePath(abs),
      detail: `${kind === 'upload' ? 'ลิงก์รับไฟล์, ' : ''}${body.days} วัน${max ? `, ดาวน์โหลดได้ ${max} ครั้ง` : ''}${password ? ', มีรหัสผ่าน' : ''}`,
    })
    // the only time the token is told: it is not stored
    return { share: publicShare(share), token, url: `/s/${token}` }
  }, {
    body: t.Object({
      space: t.String(), path: t.String(), days: t.Number(),
      password: t.Optional(t.String({ maxLength: 1000 })), maxDownloads: t.Optional(t.Nullable(t.Number())),
      kind: t.Optional(t.Union([t.Literal('download'), t.Literal('upload')])),
      maxFileBytes: t.Optional(t.Nullable(t.Number())), maxFiles: t.Optional(t.Nullable(t.Number())),
      maxTotalBytes: t.Optional(t.Nullable(t.Number())), note: t.Optional(t.String({ maxLength: 5000 })),
    }),
  })

  .get('/shares', ({ user, ip }) => {
    const u = requireUser({ user, ip })
    return { shares: sharesOf(u.username).map(publicShare) }
  })

  // the link again, for copying: its owner or an admin, while it still works. Someone else's link is "not found"
  .get('/shares/:id/link', ({ user, ip, params }) => {
    const u = requireUser({ user, ip })
    const share = findShare(params.id)
    if (!share || (share.owner.toLowerCase() !== u.username.toLowerCase() && u.role !== 'admin')) throw notFound()
    const token = stateOf(share) === 'active' ? shareToken(share) : null
    if (!token) throw new HttpError(409, 'share.link-unavailable')
    audit({ user: u.username, ip, action: 'share-link-view', target: shareTarget(share), detail: share.owner })
    return { token, url: `/s/${token}` }
  })

  .delete('/shares/:id', ({ user, ip, params }) => {
    const u = requireUser({ user, ip })
    const share = findShare(params.id)
    // someone else's link is "not found" too: ids are not to be probed
    if (!share || (share.owner.toLowerCase() !== u.username.toLowerCase() && u.role !== 'admin' && !canManage(u, findUser(share.owner)))) throw notFound()
    revokeShare(share)
    audit({ user: u.username, ip, action: 'share-revoke', target: shareTarget(share), detail: share.owner })
    return { ok: true }
  })

  .get('/admin/shares', ({ user, ip }) => {
    // a manager: the links of the users they manage
    const actor = requireStaff({ user, ip })
    return { shares: allShares().filter(s => actor.role === 'admin' || canManage(actor, findUser(s.owner))).map(publicShare) }
  })

  // ───────────── public: whoever holds the link ─────────────
  .get('/s/:token', async ({ params, query, request }) => {
    const { share, abs } = openShare(params.token)
    const expiresAt = share.expiresAt
    if (kindOf(share) === 'upload') {
      // never the folder's contents: the visitor only sees where the files go, the rules and what they sent themselves
      if (!isUnlocked(share, request)) return { kind: 'upload', name: null, type: null, expiresAt, needsPassword: true }
      const key = visitorKey(request)
      return {
        kind: 'upload', name: basename(abs), type: 'dir', expiresAt, needsPassword: false, note: share.note ?? '',
        // the limits that really apply: an unset one is the server's default, so the page never says "no limit" when there is one
        maxFileBytes: share.maxFileBytes ?? config.uploadRequestMaxFile, maxFiles: share.maxFiles ?? null,
        maxTotalBytes: share.maxTotalBytes ?? config.uploadRequestMaxTotal,
        uploadedFiles: share.uploadedFiles ?? 0, uploadedBytes: share.uploadedBytes ?? 0, full: uploadFull(share),
        mine: key ? uploadsBy(share, key) : [],
      }
    }
    if (!isUnlocked(share, request)) return { name: null, type: null, size: null, expiresAt, needsPassword: true }
    const name = basename(abs)
    if (share.type === 'file') return { name, type: 'file', size: lstatSync(abs).size, expiresAt, needsPassword: false }
    const at = insideShare(abs, query.path)
    let st
    try { st = lstatSync(at.abs) } catch { throw notFound() }
    if (!st.isDirectory()) throw bad('files.not-a-folder')
    // a big folder takes a while to count: other requests are answered meanwhile
    const size = (await treeStats(abs, 50_000)).size
    return { name, type: 'dir', size, expiresAt, needsPassword: false, path: at.rel, entries: await listDirAsync(at.abs, at.rel) }
  }, { query: t.Object({ path: t.Optional(t.String()) }) })

  .post('/s/:token/unlock', async ({ params, body, ip, cookie }) => {
    const { share } = openShare(params.token)
    if (!share.passwordHash) return { ok: true }
    const key = lockoutKey(share, ip)
    const wait = lockedFor(key)
    if (wait) throw new HttpError(429, 'auth.confirm-locked', { seconds: wait })
    if (!(await Bun.password.verify(body.password, share.passwordHash).catch(() => false))) {
      if (recordFailure(key, SHARE_LOCKOUT)) alert('lockout', 'admin.alert-share-locked', { share: share.id, owner: share.owner, ip })
      throw new HttpError(403, 'auth.wrong-password')
    }
    clearFailures(key)
    // only this link's address gets the cookie, and it is signed for this link alone
    cookie[SHARE_COOKIE].set({
      value: unlockCookie(share), httpOnly: true, sameSite: 'strict', path: `/api/s/${params.token}`,
      secure: config.secureCookie, maxAge: Math.floor(UNLOCK_MS / 1000),
    })
    return { ok: true }
  }, { body: t.Object({ password: t.String({ maxLength: 1000 }) }) })

  .get('/s/:token/download', ({ params, query, request, user, ip }) => {
    const { share, abs } = openShare(params.token, 'download')
    needUnlocked(share, request)
    let target = abs
    if (share.type === 'dir') target = insideShare(abs, query.path).abs
    else if (normRel(query.path) !== '/') throw notFound()
    let st
    try { st = lstatSync(target) } catch { throw notFound() }
    if (!st.isFile() && !st.isDirectory()) throw notFound()

    // throws the same 404 when the last allowed downloads are already under way
    const slot = startDownload(share)
    try {
      audit({
        user: user?.username ?? 'guest', ip, action: 'share-download', target: storagePath(target),
        detail: `ลิงก์ ${share.id} ของ ${share.owner}`,
      })
      if (st.isFile()) {
        // with a download limit only whole files are sent: parts of a file could be fetched without ever counting
        const res = fileResponse(target, basename(target), request, false, share.maxDownloads === null)
        return share.maxDownloads === null ? settled(res, slot) : counted(res, slot)
      }
      const zipName = `${basename(target)}.zip`
      const zip = new Response(zipStream(collectZipItems(dirname(target), [basename(target)])), {
        headers: {
          'Content-Type': 'application/zip',
          'Content-Disposition': contentDisposition('attachment', zipName),
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'none'; sandbox",
          'Cache-Control': 'no-store',
        },
      })
      return share.maxDownloads === null ? settled(zip, slot) : counted(zip, slot)
    } catch (err) {
      slot.release()
      throw err
    }
  }, { query: t.Object({ path: t.Optional(t.String()) }) })

  // ───────────── public: upload-request links ─────────────
  // The visitor has no session. What ties an upload to them is the random key in an HttpOnly, SameSite=Strict cookie
  // that only this link's path receives; the upload's owner name carries the link id and that key (see visitorUpload).
  .post('/s/:token/upload', async ({ params, body, request, ip, cookie }) => {
    const first = openShare(params.token, 'upload')
    needUnlocked(first.share, request)
    const owner = findUser(first.share.owner)
    // the owner's count is awaited first; everything from the limits to the reservation below has no await
    if (owner && first.share.space === 'home') await ready(owner)
    const { share, abs } = openShare(params.token, 'upload')
    needUnlocked(share, request)
    const a = owner ? accessFor(owner, share.space) : null
    if (!owner || !a) throw notFound()
    const size = Number(body.size)
    if (!Number.isSafeInteger(size) || size < 0) throw bad('upload.bad-size')
    // a link made without limits gets the server's defaults, so no link is open-ended
    const maxFile = share.maxFileBytes ?? config.uploadRequestMaxFile
    const maxTotal = share.maxTotalBytes ?? config.uploadRequestMaxTotal
    if (size > maxFile) throw new HttpError(413, 'share.upload-too-big', { max: maxFile, maxText: sizeText(maxFile) })
    const load = shareUploadLoad(share.id, ip)
    if (load.count >= SHARE_UPLOADS_PER_LINK || load.byIp >= SHARE_UPLOADS_PER_IP) throw new HttpError(429, 'share.upload-busy')
    // finished and announced files both count, so parallel announcements can not pass the limit together
    const files = (share.uploadedFiles ?? 0) + load.count
    const total = (share.uploadedBytes ?? 0) + load.bytes
    if ((share.maxFiles != null && files + 1 > share.maxFiles) || total + size > maxTotal) {
      throw new HttpError(403, 'share.upload-full')
    }
    const key = visitorKey(request) ?? randomBytes(16).toString('hex')
    // the bytes count against the owner's quota when the link is in their home space
    const started = initUpload({
      owner: `share:${share.id}:${key}`,
      // bytes nobody's quota holds (the public space, an owner without a quota) count against the visitors' daily allowance
      guest: share.space === 'public' || !quotaOf(owner),
      quotaUser: share.space === 'home' ? owner : undefined,
      shareId: share.id,
      ip,
      root: abs,
      dir: '/',
      relativeDir: [],
      name: body.name,
      size,
    })
    if (!visitorKey(request)) {
      cookie[VISITOR_COOKIE].set({
        value: key, httpOnly: true, sameSite: 'strict', path: `/api/s/${params.token}`,
        secure: config.secureCookie, maxAge: VISITOR_MAX_AGE_S,
      })
    }
    return started
  }, { body: t.Object({ name: t.String(), size: t.Number() }) })

  .put('/s/:token/upload/:id/:n', async ({ params, request }) => {
    const { owner } = visitorUpload(params.token, request)
    // before buffering a whole chunk in memory: a stranger without a valid upload id costs nothing
    checkUpload(params.id, owner)
    const data = await request.arrayBuffer()
    await saveChunk(params.id, owner, Number(params.n), data)
    return { ok: true }
  }, { parse: 'none' })

  .post('/s/:token/upload/:id/complete', async ({ params, request, ip }) => {
    const { share, owner, key } = visitorUpload(params.token, request)
    const done = await completeUpload(params.id, owner)
    const name = basename(done.path)
    recordUpload(share, key, name, done.size)
    // only the owner of the link is told
    notify(share.owner, 'upload-received', { link: nameOf(share.path), linkId: share.id, file: name, size: done.size }, filesLink(share))
    audit({
      user: 'guest', ip, action: 'share-upload', target: storagePath(done.path),
      detail: `ลิงก์ ${share.id} ของ ${share.owner}: ${name} (${done.size} ไบต์)`,
    })
    return { ok: true, name, size: done.size }
  })

  .delete('/s/:token/upload/:id', ({ params, request }) => {
    const { owner } = visitorUpload(params.token, request)
    cancelUpload(params.id, owner)
    return { ok: true }
  })
