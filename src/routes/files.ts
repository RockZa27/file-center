import { randomBytes } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { Elysia, t } from 'elysia'
import { audit } from '../audit'
import { config, paths } from '../config'
import { context, need, requireUser } from '../context'
import {
  bad, conflict, copyTree, ensureSpace, forbidden, freeSpace, fromFsError, HttpError, isDir, joinRel, listDir, moveTree,
  normRel, notFound, resolveIn, sameFile, searchTree, storagePath, treeStats, uniquePath, validName, within,
} from '../fsx'
import { log } from '../logger'
import { type Lang, langOf, type MessageCode, text } from '../messages'
import { recordRecent, moveState } from '../favorites'
import { exceeded, holdNow, markStale, ownerOfPath, ready, roomLeft, usage } from '../quota'
import { moveToTrash } from '../trash'
import { moveVersions, reserveVersion } from '../versions'
import { collectZipItems, unzipTo, zipStream } from '../zip'

const MAX_TEXT = 2 * 1024 * 1024

/** the visitor page and the user folders live here: they may be copied, but never deleted, moved or renamed */
function guardSystemFolder(abs: string) {
  if (abs === paths.publicDir || abs === paths.usersDir) throw forbidden('files.system-folder')
}

const spaceQ = t.Object({ space: t.String(), path: t.Optional(t.String()) })
const SAFE_INLINE = new Set([
  '.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.avif',
  '.mp4', '.webm', '.mp3', '.wav', '.ogg', '.m4a', '.txt',
])

function items(input: string[], max = 2000): string[] {
  if (!input.length || input.length > max) throw bad('files.bad-count')
  return input.map(p => {
    const n = normRel(p)
    if (n === '/') throw bad('files.root-item')
    return n
  })
}

export function contentDisposition(kind: 'inline' | 'attachment', name: string) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()]/g, escape)}`
}

/** `ranges: false` always sends the whole file (a share link with a download limit counts whole downloads only) */
export function fileResponse(abs: string, name: string, request: Request, wantInline: boolean, ranges = true) {
  const st = statSync(abs)
  const ext = extname(name).toLowerCase()
  const inline = wantInline && SAFE_INLINE.has(ext)
  const file = Bun.file(abs)
  const headers: Record<string, string> = {
    'Content-Type': inline ? file.type : file.type.startsWith('text/') ? 'application/octet-stream' : file.type || 'application/octet-stream',
    'Content-Disposition': contentDisposition(inline ? 'inline' : 'attachment', name),
    'Accept-Ranges': ranges ? 'bytes' : 'none',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, no-cache',
  }
  // the browser's PDF viewer does not work inside a CSP sandbox; everything else is locked down
  if (!(inline && ext === '.pdf')) headers['Content-Security-Policy'] = "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox"
  const range = ranges ? request.headers.get('range')?.match(/^bytes=(\d*)-(\d*)$/) : null
  // "bytes=-" names no range at all: send the whole file
  if (range && (range[1] || range[2]) && st.size > 0) {
    let start = range[1] ? Number(range[1]) : NaN
    let end = range[2] ? Number(range[2]) : NaN
    if (Number.isNaN(start)) { start = Math.max(0, st.size - end); end = st.size - 1 }
    else if (Number.isNaN(end) || end >= st.size) end = st.size - 1
    if (start > end || start >= st.size) {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${st.size}` } })
    }
    return new Response(file.slice(start, end + 1), {
      status: 206,
      headers: { ...headers, 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${st.size}` },
    })
  }
  return new Response(file, { headers: { ...headers, 'Content-Length': String(st.size) } })
}

type Batch = { owner: string; space: string; root: string; dir: string; names: string[]; expires: number }
const batches = new Map<string, Batch>()

export const fileRoutes = new Elysia({ prefix: '/api' })
  .use(context)

  // ───────────── quota ─────────────
  .get('/me/usage', ({ user, ip }) => usage(requireUser({ user, ip })))

  // ───────────── browse ─────────────
  .get('/list', ({ user, query }) => {
    const a = need({ user, ip: '' }, query.space, 'read')
    const rel = normRel(query.path)
    const abs = resolveIn(a.root, rel)
    if (!existsSync(abs)) throw notFound('files.folder-not-found')
    if (!isDir(abs)) throw bad('files.not-a-folder')
    return { path: rel, entries: listDir(abs, rel), permissions: [...a.perms] }
  }, { query: spaceQ })

  .get('/folders', ({ user, query }) => {
    // folders only, used by the "choose destination" dialog
    const a = need({ user, ip: '' }, query.space, 'read')
    const rel = normRel(query.path)
    const abs = resolveIn(a.root, rel)
    if (!isDir(abs)) throw notFound('files.folder-not-found')
    return { path: rel, entries: listDir(abs, rel).filter(e => e.type === 'dir') }
  }, { query: spaceQ })

  .get('/search', async ({ user, query }) => {
    const a = need({ user, ip: '' }, query.space, 'read')
    const needle = query.q.trim().toLowerCase()
    if (needle.length < 1) return { results: [], truncated: false }
    const startRel = normRel(query.path)
    // a walk of up to 50,000 entries: in batches, so other requests are answered meanwhile
    return await searchTree(resolveIn(a.root, startRel), startRel, needle)
  }, { query: t.Object({ space: t.String(), q: t.String(), path: t.Optional(t.String()) }) })

  // ───────────── create / edit ─────────────
  .post('/mkdir', ({ user, ip, body }) => {
    const a = need({ user, ip }, body.space, 'write')
    const dir = resolveIn(a.root, normRel(body.path))
    if (!isDir(dir)) throw notFound('files.folder-not-found')
    const name = validName(body.name)
    const target = join(dir, name)
    if (existsSync(target)) throw conflict('files.name-taken')
    mkdirSync(target)
    audit({ user: user?.username ?? 'guest', ip, action: 'mkdir', target: storagePath(target) })
    return { ok: true }
  }, { body: t.Object({ space: t.String(), path: t.String(), name: t.String() }) })

  .post('/newfile', ({ user, ip, body }) => {
    const a = need({ user, ip }, body.space, 'write')
    const dir = resolveIn(a.root, normRel(body.path))
    if (!isDir(dir)) throw notFound('files.folder-not-found')
    const name = validName(body.name)
    const target = join(dir, name)
    if (existsSync(target)) throw conflict('files.name-taken')
    writeFileSync(target, '')
    audit({ user: user?.username ?? 'guest', ip, action: 'create', target: storagePath(target) })
    return { ok: true }
  }, { body: t.Object({ space: t.String(), path: t.String(), name: t.String() }) })

  .get('/content', async ({ user, query }) => {
    const a = need({ user, ip: '' }, query.space, 'read', 'download')
    const abs = resolveIn(a.root, normRel(query.path))
    const st = existsSync(abs) ? statSync(abs) : null
    if (!st || !st.isFile()) throw notFound()
    if (st.size > MAX_TEXT) throw new HttpError(413, 'files.too-big-to-open')
    recordRecent(user, query.space, normRel(query.path))
    return { content: await Bun.file(abs).text(), mtime: Math.round(st.mtimeMs) }
  }, { query: spaceQ })

  .put('/content', async ({ user, ip, body }) => {
    const a = need({ user, ip }, body.space, 'write')
    // the count is awaited first: from the check of the version to the write there is no await
    const q = a.space === 'home' ? user : null
    await ready(q)
    const rel = normRel(body.path)
    const abs = resolveIn(a.root, rel)
    // the earlier versions of the file count against the owner of the home it is in (not always the one saving)
    const owner = ownerOfPath(abs)
    await ready(owner)
    const st = existsSync(abs) ? statSync(abs) : null
    if (!st || !st.isFile()) throw notFound()
    if (Buffer.byteLength(body.content) > MAX_TEXT) throw new HttpError(413, 'files.text-too-big')
    // the mtime GET /api/content gave: someone else saved since then, and writing now would silently undo their work
    // check and write in one step, with no await between them: two saves of the same version can not both pass
    if (body.expectedMtime !== undefined && Math.round(st.mtimeMs) !== body.expectedMtime) throw conflict('files.changed-elsewhere')
    // only the growth counts against the quota
    const grow = Buffer.byteLength(body.content) - st.size
    // the content that is replaced is kept first; over the quota even after the oldest versions went, the save is refused
    const ticket = reserveVersion(owner, abs)
    let hold
    try { hold = holdNow(q, grow) } catch (err) { ticket?.release(); throw err }
    try {
      ticket?.keep('edit', user?.username ?? 'guest')
      writeFileSync(abs, body.content)
    } catch (err) {
      hold.release()
      ticket?.release()
      throw err
    }
    hold.commit(grow)
    if (grow < 0 && q) markStale(q.username)
    audit({ user: user?.username ?? 'guest', ip, action: 'edit', target: storagePath(abs) })
    recordRecent(user, body.space, rel)
    // the next save sends this one back
    return { ok: true, mtime: Math.round(statSync(abs).mtimeMs) }
  }, { body: t.Object({ space: t.String(), path: t.String(), content: t.String(), expectedMtime: t.Optional(t.Number()) }) })

  // ───────────── rename / copy / move / delete ─────────────
  .post('/rename', async ({ user, ip, body }) => {
    const a = need({ user, ip }, body.space, 'write')
    const rel = normRel(body.path)
    if (rel === '/') throw bad('files.rename-root')
    const from = resolveIn(a.root, rel)
    if (!existsSync(from)) throw notFound()
    guardSystemFolder(from)
    const name = validName(body.name)
    const to = join(dirname(from), name)
    if (to === from) return { ok: true }
    // "a.txt" -> "A.txt" is the same file on a case-insensitive disk, but a different one on Linux
    if (existsSync(to) && !sameFile(from, to)) throw conflict('files.name-taken')
    await moveTree(from, to)
    moveVersions(from, to)
    moveState(from, to)
    audit({ user: user?.username ?? 'guest', ip, action: 'rename', target: storagePath(from), detail: name })
    return { ok: true }
  }, { body: t.Object({ space: t.String(), path: t.String(), name: t.String() }) })

  .post('/copy', ({ user, ip, body, request }) => transfer('copy', user, ip, body, langOf(request)), {
    body: t.Object({ space: t.String(), items: t.Array(t.String()), dest: t.String(), destSpace: t.Optional(t.String()) }),
  })
  .post('/move', ({ user, ip, body, request }) => transfer('move', user, ip, body, langOf(request)), {
    body: t.Object({ space: t.String(), items: t.Array(t.String()), dest: t.String(), destSpace: t.Optional(t.String()) }),
  })

  .post('/delete', async ({ user, ip, body, request }) => {
    const a = need({ user, ip }, body.space, 'write')
    const failed: { path: string; error: string }[] = []
    let done = 0
    for (const rel of items(body.items)) {
      try {
        const abs = resolveIn(a.root, rel)
        if (!existsSync(abs) && !lstatExists(abs)) throw notFound()
        guardSystemFolder(abs)
        await moveToTrash(abs, user?.username ?? 'guest')
        done++
        audit({ user: user?.username ?? 'guest', ip, action: 'delete', target: storagePath(abs) })
      } catch (e) {
        failed.push({ path: rel, error: itemError(e, 'files.delete-failed', langOf(request)) })
      }
    }
    // the trash is outside the home: the space is free again. An admin works in every home.
    if (done && a.space === 'home') markStale(user?.role === 'admin' ? undefined : user?.username)
    return { done, failed }
  }, { body: t.Object({ space: t.String(), items: t.Array(t.String()) }) })

  // ───────────── zip / unzip ─────────────
  .post('/zip', async ({ user, ip, body }) => {
    const a = need({ user, ip }, body.space, 'zip', 'write')
    const q = a.space === 'home' ? user : null
    await ready(q)
    const dirRel = normRel(body.path)
    const dir = resolveIn(a.root, dirRel)
    if (!isDir(dir)) throw notFound()
    const names = body.items.map(validName)
    for (const n of names) if (!existsSync(join(dir, n))) throw notFound('files.item-missing', { name: n })
    let archive = validName(body.name || 'archive.zip')
    if (!archive.toLowerCase().endsWith('.zip')) archive += '.zip'
    const target = uniquePath(join(dir, archive))
    // do not put the archive inside itself
    const zipItems = collectZipItems(dir, names).filter(i => i.abs !== target)
    // the archive is at most about as big as what goes in
    const upper = zipItems.reduce((sum, i) => sum + i.size, 0)
    ensureSpace(dir, upper)
    const hold = holdNow(q, upper)
    try {
      await Bun.write(target, new Response(zipStream(zipItems)))
    } catch (err) {
      rmSync(target, { force: true })
      hold.release()
      throw err
    }
    hold.commit(statSync(target).size)
    audit({ user: user?.username ?? 'guest', ip, action: 'zip', target: storagePath(target), detail: `${names.length} รายการ` })
    return { ok: true, name: basename(target) }
  }, { body: t.Object({ space: t.String(), path: t.String(), items: t.Array(t.String()), name: t.Optional(t.String()) }) })

  .post('/unzip', async ({ user, ip, body }) => {
    const a = need({ user, ip }, body.space, 'zip', 'write')
    const q = a.space === 'home' ? user : null
    await ready(q)
    const rel = normRel(body.path)
    const abs = resolveIn(a.root, rel)
    if (!existsSync(abs) || !statSync(abs).isFile() || extname(abs).toLowerCase() !== '.zip') throw bad('zip.not-zip')
    const folderName = basename(abs, extname(abs))
    const dest = uniquePath(join(dirname(abs), folderName))
    // never extract more than the disk can take while keeping the configured reserve free
    const free = freeSpace(dirname(abs))
    const otherMax = Math.min(config.unzipMaxBytes, free === null ? Infinity : Math.max(0, free - config.minFreeSpace))
    // what the quota leaves is the budget when it is the smaller one; the budget is held while the files come out
    const room = q ? roomLeft(q) : Infinity
    const maxBytes = Math.min(otherMax, room)
    const hold = holdNow(q, maxBytes)
    mkdirSync(dest)
    try {
      const count = await unzipTo(abs, dest, { maxBytes, maxFiles: config.unzipMaxFiles })
      hold.commit((await treeStats(dest)).size)
      audit({ user: user?.username ?? 'guest', ip, action: 'unzip', target: storagePath(abs), detail: `${count} ไฟล์` })
      return { ok: true, folder: basename(dest), files: count }
    } catch (err) {
      // a half-extracted folder is useless; keeping it in the trash would only hold the disk space for weeks
      rmSync(dest, { recursive: true, force: true })
      hold.release()
      // too much for the quota is a full home, not a zip that is too big
      if (q && room < otherMax && err instanceof HttpError && err.code === 'zip.too-big') throw exceeded(q)
      throw err instanceof HttpError ? err : bad('zip.extract-failed')
    }
  }, { body: t.Object({ space: t.String(), path: t.String() }) })

  // ───────────── download ─────────────
  .get('/download', ({ user, ip, query, request }) => {
    const a = need({ user, ip }, query.space, 'download')
    const rel = normRel(query.path)
    const abs = resolveIn(a.root, rel)
    if (!existsSync(abs) || !statSync(abs).isFile()) throw notFound()
    const range = request.headers.get('range')
    if (!range || range.startsWith('bytes=0-')) {
      if (query.inline !== '1') audit({ user: user?.username ?? 'guest', ip, action: 'download', target: storagePath(abs) })
      recordRecent(user, query.space, rel)
    }
    return fileResponse(abs, basename(abs), request, query.inline === '1')
  }, { query: t.Object({ space: t.String(), path: t.String(), inline: t.Optional(t.String()) }) })

  .post('/batch', ({ user, ip, body }) => {
    const a = need({ user, ip }, body.space, 'download', 'batchdownload')
    const dirRel = normRel(body.path)
    const dir = resolveIn(a.root, dirRel)
    if (!isDir(dir)) throw notFound()
    const names = body.items.map(validName)
    for (const n of names) if (!existsSync(join(dir, n))) throw notFound('files.item-missing', { name: n })
    const token = randomBytes(18).toString('base64url')
    const now = Date.now()
    for (const [k, v] of batches) if (v.expires < now) batches.delete(k)
    batches.set(token, { owner: user?.username ?? 'guest', space: body.space, root: a.root, dir: dirRel, names, expires: now + 5 * 60_000 })
    return { token }
  }, { body: t.Object({ space: t.String(), path: t.String(), items: t.Array(t.String()) }) })

  .get('/batch/:token', ({ user, ip, params }) => {
    const b = batches.get(params.token)
    if (!b || b.expires < Date.now()) throw notFound('files.link-expired')
    if (b.owner !== (user?.username ?? 'guest')) throw new HttpError(403, 'files.download-forbidden')
    // rights, the public page or the user's folder may have changed since the link was made
    const a = need({ user, ip }, b.space, 'download', 'batchdownload')
    if (a.root !== b.root) throw new HttpError(403, 'files.download-forbidden')
    const dir = resolveIn(b.root, b.dir)
    const list = collectZipItems(dir, b.names)
    audit({ user: b.owner, ip, action: 'download-zip', target: storagePath(dir), detail: `${b.names.length} รายการ` })
    const name = b.names.length === 1 ? `${b.names[0]}.zip` : `${basename(b.dir === '/' ? 'files' : b.dir)}.zip`
    return new Response(zipStream(list), {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': contentDisposition('attachment', name),
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
      },
    })
  })

function lstatExists(abs: string) {
  try { lstatSync(abs); return true } catch { return false }
}

/** what to tell the user (in their language) about one failed item of a batch, never a raw error with server paths */
function itemError(e: unknown, fallback: MessageCode, lang: Lang) {
  const known = fromFsError(e)
  if (!known) log.error('file-item-failed', e)
  return known ? text(lang, known.code, known.params) : text(lang, fallback)
}

async function transfer(
  kind: 'copy' | 'move', user: any, ip: string,
  body: { space: string; items: string[]; dest: string; destSpace?: string }, lang: Lang,
) {
  const cross = body.destSpace !== undefined && body.destSpace !== body.space
  // inside one space: write, as it always was. Between spaces: the source must be readable (a copy also downloadable,
  // a move also writable, the source goes) and the destination must take new files (write + upload)
  const a = cross ? need({ user, ip }, body.space, ...(kind === 'copy' ? ['read', 'download'] as const : ['read', 'write'] as const)) : need({ user, ip }, body.space, 'write')
  const d = cross ? need({ user, ip }, body.destSpace, 'write', 'upload') : a
  // a move inside one space does not change what a home holds; a copy (or a move into another space) adds the size
  const q = d.space === 'home' ? user : null
  if (kind === 'copy' || cross) await ready(q)
  const destRel = normRel(body.dest)
  const destAbs = resolveIn(d.root, destRel)
  if (!isDir(destAbs)) throw notFound('files.dest-not-found')
  const failed: { path: string; error: string }[] = []
  let done = 0
  for (const rel of items(body.items)) {
    try {
      const from = resolveIn(a.root, rel)
      if (!lstatExists(from)) throw notFound()
      const to = join(destAbs, basename(from))
      if (kind === 'move') guardSystemFolder(from)
      if (kind === 'move' && !cross) {
        if (to === from) throw conflict('files.same-folder')
        if (isDir(from) && within(from, destAbs)) throw bad('files.move-into-self')
        if (existsSync(to)) throw conflict('files.dest-name-taken')
        await moveTree(from, to)
        moveVersions(from, to)
        moveState(from, to)
      } else {
        // the spaces overlap for an admin (the home is the whole storage): a folder still can not go into itself
        if (cross && isDir(from) && within(from, destAbs)) {
          if (kind === 'move') throw bad('files.move-into-self')
          throw bad('files.copy-into-self')
        }
        if (kind === 'move' && existsSync(to)) throw conflict('files.dest-name-taken')
        // counting a big folder takes a while: other requests are answered meanwhile
        const size = isDir(from) ? (await treeStats(from)).size : lstatSync(from).size
        ensureSpace(destAbs, size)
        const hold = holdNow(q, size)
        const target = kind === 'move' ? to : uniquePath(to)
        try {
          await copyTree(from, target)
        } catch (err) {
          hold.release()
          throw err
        }
        hold.commit()
        if (kind === 'move') {
          // copy first, then delete the source (to the trash, like a delete): when that fails the copy goes again
          try {
            await moveToTrash(from, user?.username ?? 'guest')
          } catch (err) {
            rmSync(target, { recursive: true, force: true })
            markStale(q?.username)
            throw err
          }
          if (a.space === 'home') markStale(user?.role === 'admin' ? undefined : user?.username)
        }
      }
      done++
      audit({ user: user?.username ?? 'guest', ip, action: kind, target: storagePath(from), detail: storagePath(destAbs) })
    } catch (e) {
      failed.push({ path: rel, error: itemError(e, 'files.transfer-failed', lang) })
    }
  }
  return { done, failed }
}
