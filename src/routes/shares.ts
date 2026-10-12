import { lstatSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { Elysia, t } from 'elysia'
import { audit } from '../audit'
import { clearFailures, hashPassword, lockedFor, recordFailure } from '../auth'
import { config } from '../config'
import { context, need, requireAdmin, requireUser } from '../context'
import { bad, HttpError, listDir, normRel, notFound, resolveIn, storagePath, treeStats } from '../fsx'
import {
  allShares, createShare, findShare, isUnlocked, lockoutKey, openShare, publicShare, revokeShare, type Share, SHARE_COOKIE,
  SHARE_DAYS, SHARE_LOCKOUT, SHARE_MAX_DOWNLOADS, SHARE_PASSWORD_MIN, shareTarget, SHARES_PER_USER, sharesOf, startDownload,
  UNLOCK_MS, unlockCookie,
} from '../shares'
import { collectZipItems, zipStream } from '../zip'
import { contentDisposition, fileResponse } from './files'

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

/** the link is there but has a password this browser has not given yet */
function needUnlocked(share: Share, request: Request) {
  if (!isUnlocked(share, request)) throw new HttpError(401, 'share.password-required')
}

/**
 * Count a download once its last byte has been handed over; a cancelled download (or an error half way) only gives
 * its place back. Answers other than a whole file (206 parts, 416) never count.
 */
function counted(res: Response, slot: { finish(): void; release(): void }): Response {
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

export const shareRoutes = new Elysia({ prefix: '/api' })
  .use(context)

  // ───────────── the owner's links ─────────────
  .post('/shares', async ({ user, ip, body }) => {
    // visitors never make links, whatever the guest permissions say
    const owner = requireUser({ user, ip })
    const a = need({ user, ip }, body.space, 'share', 'download')
    const rel = normRel(body.path)
    if (rel === '/') throw bad('files.root-item')
    const abs = resolveIn(a.root, rel)
    let st
    try { st = lstatSync(abs) } catch { throw notFound() }
    if (st.isSymbolicLink() || !(st.isFile() || st.isDirectory())) throw notFound()

    const days = SHARE_DAYS.filter(d => d <= config.shareMaxDays)
    if (!days.includes(body.days)) throw bad('share.bad-days', { days: days.join(', ') })
    const max = body.maxDownloads ?? null
    if (max !== null && (!Number.isInteger(max) || max < 1 || max > SHARE_MAX_DOWNLOADS)) {
      throw bad('share.bad-max-downloads', { max: SHARE_MAX_DOWNLOADS })
    }
    const password = body.password || null
    if (password !== null && password.length < SHARE_PASSWORD_MIN) throw bad('share.password-too-short', { min: SHARE_PASSWORD_MIN })
    if (password !== null && password.length > 200) throw bad('auth.password-too-long')
    if (sharesOf(owner.username).length >= SHARES_PER_USER) throw bad('share.too-many', { max: SHARES_PER_USER })

    const { share, token } = createShare({
      owner: owner.username,
      space: a.space,
      path: rel,
      type: st.isDirectory() ? 'dir' : 'file',
      expiresAt: new Date(Date.now() + body.days * 86_400_000).toISOString(),
      maxDownloads: max,
      ...(password ? { passwordHash: await hashPassword(password) } : {}),
    })
    // the path, never the token
    audit({
      user: owner.username, ip, action: 'share-create', target: storagePath(abs),
      detail: `${body.days} วัน${max ? `, ดาวน์โหลดได้ ${max} ครั้ง` : ''}${password ? ', มีรหัสผ่าน' : ''}`,
    })
    // the only time the token is told: it is not stored
    return { share: publicShare(share), token, url: `/s/${token}` }
  }, {
    body: t.Object({
      space: t.String(), path: t.String(), days: t.Number(),
      password: t.Optional(t.String({ maxLength: 1000 })), maxDownloads: t.Optional(t.Nullable(t.Number())),
    }),
  })

  .get('/shares', ({ user, ip }) => {
    const u = requireUser({ user, ip })
    return { shares: sharesOf(u.username).map(publicShare) }
  })

  .delete('/shares/:id', ({ user, ip, params }) => {
    const u = requireUser({ user, ip })
    const share = findShare(params.id)
    // someone else's link is "not found" too: ids are not to be probed
    if (!share || (share.owner.toLowerCase() !== u.username.toLowerCase() && u.role !== 'admin')) throw notFound()
    revokeShare(share)
    audit({ user: u.username, ip, action: 'share-revoke', target: shareTarget(share), detail: share.owner })
    return { ok: true }
  })

  .get('/admin/shares', ({ user, ip }) => {
    requireAdmin({ user, ip })
    return { shares: allShares().map(publicShare) }
  })

  // ───────────── public: whoever holds the link ─────────────
  .get('/s/:token', async ({ params, query, request }) => {
    const { share, abs } = openShare(params.token)
    const expiresAt = share.expiresAt
    if (!isUnlocked(share, request)) return { name: null, type: null, size: null, expiresAt, needsPassword: true }
    const name = basename(abs)
    if (share.type === 'file') return { name, type: 'file', size: lstatSync(abs).size, expiresAt, needsPassword: false }
    const at = insideShare(abs, query.path)
    let st
    try { st = lstatSync(at.abs) } catch { throw notFound() }
    if (!st.isDirectory()) throw bad('files.not-a-folder')
    // a big folder takes a while to count: other requests are answered meanwhile
    const size = (await treeStats(abs, 50_000)).size
    return { name, type: 'dir', size, expiresAt, needsPassword: false, path: at.rel, entries: listDir(at.abs, at.rel) }
  }, { query: t.Object({ path: t.Optional(t.String()) }) })

  .post('/s/:token/unlock', async ({ params, body, ip, cookie }) => {
    const { share } = openShare(params.token)
    if (!share.passwordHash) return { ok: true }
    const key = lockoutKey(share, ip)
    const wait = lockedFor(key)
    if (wait) throw new HttpError(429, 'auth.confirm-locked', { seconds: wait })
    if (!(await Bun.password.verify(body.password, share.passwordHash).catch(() => false))) {
      recordFailure(key, SHARE_LOCKOUT)
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
    const { share, abs } = openShare(params.token)
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
        return counted(fileResponse(target, basename(target), request, false, share.maxDownloads === null), slot)
      }
      const zipName = `${basename(target)}.zip`
      return counted(new Response(zipStream(collectZipItems(dirname(target), [basename(target)])), {
        headers: {
          'Content-Type': 'application/zip',
          'Content-Disposition': contentDisposition('attachment', zipName),
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'none'; sandbox",
          'Cache-Control': 'no-store',
        },
      }), slot)
    } catch (err) {
      slot.release()
      throw err
    }
  }, { query: t.Object({ path: t.Optional(t.String()) }) })
