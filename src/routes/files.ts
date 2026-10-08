import { randomBytes } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { Elysia, t } from 'elysia'
import { audit } from '../audit'
import { config } from '../config'
import { context, need } from '../context'
import {
  bad, conflict, copySync, HttpError, isDir, joinRel, listDir, moveSync, normRel, notFound, parentRel,
  resolveIn, statEntry, uniquePath, validName, within,
} from '../fsx'
import { moveToTrash } from '../trash'
import { collectZipItems, unzipTo, zipStream } from '../zip'

const MAX_TEXT = 2 * 1024 * 1024

const spaceQ = t.Object({ space: t.String(), path: t.Optional(t.String()) })
const SAFE_INLINE = new Set([
  '.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.avif',
  '.mp4', '.webm', '.mp3', '.wav', '.ogg', '.m4a', '.txt',
])

function items(input: string[], max = 2000): string[] {
  if (!input.length || input.length > max) throw bad('จำนวนรายการไม่ถูกต้อง')
  return input.map(p => {
    const n = normRel(p)
    if (n === '/') throw bad('ไม่สามารถทำรายการกับโฟลเดอร์หลักได้')
    return n
  })
}

function contentDisposition(kind: 'inline' | 'attachment', name: string) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()]/g, escape)}`
}

function fileResponse(abs: string, name: string, request: Request, wantInline: boolean) {
  const st = statSync(abs)
  const ext = extname(name).toLowerCase()
  const inline = wantInline && SAFE_INLINE.has(ext)
  const file = Bun.file(abs)
  const headers: Record<string, string> = {
    'Content-Type': inline ? file.type : file.type.startsWith('text/') ? 'application/octet-stream' : file.type || 'application/octet-stream',
    'Content-Disposition': contentDisposition(inline ? 'inline' : 'attachment', name),
    'Accept-Ranges': 'bytes',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, no-cache',
  }
  // the browser's PDF viewer does not work inside a CSP sandbox; everything else is locked down
  if (!(inline && ext === '.pdf')) headers['Content-Security-Policy'] = "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox"
  const range = request.headers.get('range')?.match(/^bytes=(\d*)-(\d*)$/)
  if (range && st.size > 0) {
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

  // ───────────── browse ─────────────
  .get('/list', ({ user, query }) => {
    const a = need({ user, ip: '' }, query.space, 'read')
    const rel = normRel(query.path)
    const abs = resolveIn(a.root, rel)
    if (!existsSync(abs)) throw notFound('ไม่พบโฟลเดอร์นี้')
    if (!isDir(abs)) throw bad('พาธนี้ไม่ใช่โฟลเดอร์')
    return { path: rel, entries: listDir(abs, rel), permissions: [...a.perms] }
  }, { query: spaceQ })

  .get('/folders', ({ user, query }) => {
    // folders only, used by the "choose destination" dialog
    const a = need({ user, ip: '' }, query.space, 'read')
    const rel = normRel(query.path)
    const abs = resolveIn(a.root, rel)
    if (!isDir(abs)) throw notFound('ไม่พบโฟลเดอร์นี้')
    return { path: rel, entries: listDir(abs, rel).filter(e => e.type === 'dir') }
  }, { query: spaceQ })

  .get('/search', ({ user, query }) => {
    const a = need({ user, ip: '' }, query.space, 'read')
    const needle = query.q.trim().toLowerCase()
    if (needle.length < 1) return { results: [], truncated: false }
    const startRel = normRel(query.path)
    const results: ReturnType<typeof statEntry>[] = []
    const stack: [string, string][] = [[resolveIn(a.root, startRel), startRel]]
    let visited = 0
    let truncated = false
    while (stack.length && !truncated) {
      const [dir, rel] = stack.pop()!
      let names: string[]
      try { names = readdirSync(dir) } catch { continue }
      for (const n of names) {
        if (++visited > 50_000 || results.length >= 200) { truncated = true; break }
        const e = statEntry(join(dir, n), joinRel(rel, n))
        if (!e) continue
        if (e.name.toLowerCase().includes(needle)) results.push(e)
        if (e.type === 'dir') stack.push([join(dir, n), e.path])
      }
    }
    return { results, truncated }
  }, { query: t.Object({ space: t.String(), q: t.String(), path: t.Optional(t.String()) }) })

  // ───────────── create / edit ─────────────
  .post('/mkdir', ({ user, ip, body }) => {
    const a = need({ user, ip }, body.space, 'write')
    const dir = resolveIn(a.root, normRel(body.path))
    const name = validName(body.name)
    const target = join(dir, name)
    if (existsSync(target)) throw conflict('มีชื่อนี้อยู่แล้ว')
    mkdirSync(target)
    audit({ user: user?.username ?? 'guest', ip, action: 'mkdir', target: joinRel(normRel(body.path), name) })
    return { ok: true }
  }, { body: t.Object({ space: t.String(), path: t.String(), name: t.String() }) })

  .post('/newfile', ({ user, ip, body }) => {
    const a = need({ user, ip }, body.space, 'write')
    const dir = resolveIn(a.root, normRel(body.path))
    const name = validName(body.name)
    const target = join(dir, name)
    if (existsSync(target)) throw conflict('มีชื่อนี้อยู่แล้ว')
    writeFileSync(target, '')
    audit({ user: user?.username ?? 'guest', ip, action: 'create', target: joinRel(normRel(body.path), name) })
    return { ok: true }
  }, { body: t.Object({ space: t.String(), path: t.String(), name: t.String() }) })

  .get('/content', async ({ user, query }) => {
    const a = need({ user, ip: '' }, query.space, 'read', 'download')
    const abs = resolveIn(a.root, normRel(query.path))
    const st = existsSync(abs) ? statSync(abs) : null
    if (!st || !st.isFile()) throw notFound()
    if (st.size > MAX_TEXT) throw new HttpError(413, 'ไฟล์ใหญ่เกินกว่าจะเปิดในหน้าเว็บ')
    return { content: await Bun.file(abs).text(), mtime: Math.round(st.mtimeMs) }
  }, { query: spaceQ })

  .put('/content', async ({ user, ip, body }) => {
    const a = need({ user, ip }, body.space, 'write')
    const rel = normRel(body.path)
    const abs = resolveIn(a.root, rel)
    if (!existsSync(abs) || !statSync(abs).isFile()) throw notFound()
    if (Buffer.byteLength(body.content) > MAX_TEXT) throw new HttpError(413, 'ข้อความใหญ่เกินกำหนด')
    await Bun.write(abs, body.content)
    audit({ user: user?.username ?? 'guest', ip, action: 'edit', target: rel })
    return { ok: true }
  }, { body: t.Object({ space: t.String(), path: t.String(), content: t.String() }) })

  // ───────────── rename / copy / move / delete ─────────────
  .post('/rename', ({ user, ip, body }) => {
    const a = need({ user, ip }, body.space, 'write')
    const rel = normRel(body.path)
    if (rel === '/') throw bad('ไม่สามารถเปลี่ยนชื่อโฟลเดอร์หลักได้')
    const from = resolveIn(a.root, rel)
    if (!existsSync(from)) throw notFound()
    const name = validName(body.name)
    const to = join(dirname(from), name)
    if (to === from) return { ok: true }
    if (existsSync(to) && to.toLowerCase() !== from.toLowerCase()) throw conflict('มีชื่อนี้อยู่แล้ว')
    moveSync(from, to)
    audit({ user: user?.username ?? 'guest', ip, action: 'rename', target: rel, detail: name })
    return { ok: true }
  }, { body: t.Object({ space: t.String(), path: t.String(), name: t.String() }) })

  .post('/copy', ({ user, ip, body }) => transfer('copy', user, ip, body), {
    body: t.Object({ space: t.String(), items: t.Array(t.String()), dest: t.String() }),
  })
  .post('/move', ({ user, ip, body }) => transfer('move', user, ip, body), {
    body: t.Object({ space: t.String(), items: t.Array(t.String()), dest: t.String() }),
  })

  .post('/delete', ({ user, ip, body }) => {
    const a = need({ user, ip }, body.space, 'write')
    const failed: { path: string; error: string }[] = []
    let done = 0
    for (const rel of items(body.items)) {
      try {
        const abs = resolveIn(a.root, rel)
        if (!existsSync(abs) && !lstatExists(abs)) throw notFound()
        moveToTrash(abs, user?.username ?? 'guest')
        done++
        audit({ user: user?.username ?? 'guest', ip, action: 'delete', target: rel })
      } catch (e: any) {
        failed.push({ path: rel, error: e?.message ?? 'ลบไม่สำเร็จ' })
      }
    }
    return { done, failed }
  }, { body: t.Object({ space: t.String(), items: t.Array(t.String()) }) })

  // ───────────── zip / unzip ─────────────
  .post('/zip', async ({ user, ip, body }) => {
    const a = need({ user, ip }, body.space, 'zip', 'write')
    const dirRel = normRel(body.path)
    const dir = resolveIn(a.root, dirRel)
    if (!isDir(dir)) throw notFound()
    const names = body.items.map(validName)
    for (const n of names) if (!existsSync(join(dir, n))) throw notFound(`ไม่พบ ${n}`)
    let archive = validName(body.name || 'archive.zip')
    if (!archive.toLowerCase().endsWith('.zip')) archive += '.zip'
    const target = uniquePath(join(dir, archive))
    // do not put the archive inside itself
    const zipItems = collectZipItems(dir, names).filter(i => i.abs !== target)
    await Bun.write(target, new Response(zipStream(zipItems)))
    audit({ user: user?.username ?? 'guest', ip, action: 'zip', target: joinRel(dirRel, basename(target)), detail: `${names.length} รายการ` })
    return { ok: true, name: basename(target) }
  }, { body: t.Object({ space: t.String(), path: t.String(), items: t.Array(t.String()), name: t.Optional(t.String()) }) })

  .post('/unzip', async ({ user, ip, body }) => {
    const a = need({ user, ip }, body.space, 'zip', 'write')
    const rel = normRel(body.path)
    const abs = resolveIn(a.root, rel)
    if (!existsSync(abs) || !statSync(abs).isFile() || extname(abs).toLowerCase() !== '.zip') throw bad('ต้องเป็นไฟล์ .zip')
    const folderName = basename(abs, extname(abs))
    const dest = uniquePath(join(dirname(abs), folderName))
    mkdirSync(dest)
    try {
      const count = await unzipTo(abs, dest, config.unzipMaxBytes)
      audit({ user: user?.username ?? 'guest', ip, action: 'unzip', target: rel, detail: `${count} ไฟล์` })
      return { ok: true, folder: basename(dest), files: count }
    } catch (err) {
      moveToTrash(dest, 'system')
      throw err instanceof HttpError ? err : bad('แตกไฟล์ไม่สำเร็จ ไฟล์ zip อาจเสียหายหรือไม่รองรับ')
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
      if (query.inline !== '1') audit({ user: user?.username ?? 'guest', ip, action: 'download', target: rel })
    }
    return fileResponse(abs, basename(abs), request, query.inline === '1')
  }, { query: t.Object({ space: t.String(), path: t.String(), inline: t.Optional(t.String()) }) })

  .post('/batch', ({ user, ip, body }) => {
    const a = need({ user, ip }, body.space, 'download', 'batchdownload')
    const dirRel = normRel(body.path)
    const dir = resolveIn(a.root, dirRel)
    if (!isDir(dir)) throw notFound()
    const names = body.items.map(validName)
    for (const n of names) if (!existsSync(join(dir, n))) throw notFound(`ไม่พบ ${n}`)
    const token = randomBytes(18).toString('base64url')
    const now = Date.now()
    for (const [k, v] of batches) if (v.expires < now) batches.delete(k)
    batches.set(token, { owner: user?.username ?? 'guest', space: body.space, root: a.root, dir: dirRel, names, expires: now + 5 * 60_000 })
    return { token }
  }, { body: t.Object({ space: t.String(), path: t.String(), items: t.Array(t.String()) }) })

  .get('/batch/:token', ({ user, ip, params }) => {
    const b = batches.get(params.token)
    if (!b || b.expires < Date.now()) throw notFound('ลิงก์ดาวน์โหลดหมดอายุแล้ว')
    if (b.owner !== (user?.username ?? 'guest')) throw new HttpError(403, 'ไม่มีสิทธิ์ดาวน์โหลด')
    const dir = resolveIn(b.root, b.dir)
    const list = collectZipItems(dir, b.names)
    audit({ user: b.owner, ip, action: 'download-zip', target: b.dir, detail: `${b.names.length} รายการ` })
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

function transfer(kind: 'copy' | 'move', user: any, ip: string, body: { space: string; items: string[]; dest: string }) {
  const a = need({ user, ip }, body.space, 'write')
  const destRel = normRel(body.dest)
  const destAbs = resolveIn(a.root, destRel)
  if (!isDir(destAbs)) throw notFound('ไม่พบโฟลเดอร์ปลายทาง')
  const failed: { path: string; error: string }[] = []
  let done = 0
  for (const rel of items(body.items)) {
    try {
      const from = resolveIn(a.root, rel)
      if (!lstatExists(from)) throw notFound()
      const to = join(destAbs, basename(from))
      if (kind === 'move') {
        if (to === from) throw conflict('ปลายทางเป็นโฟลเดอร์เดียวกัน')
        if (isDir(from) && within(from, destAbs)) throw bad('ไม่สามารถย้ายโฟลเดอร์เข้าไปในตัวมันเองได้')
        if (existsSync(to)) throw conflict('มีชื่อเดียวกันอยู่ในปลายทางแล้ว')
        moveSync(from, to)
      } else {
        copySync(from, uniquePath(to))
      }
      done++
      audit({ user: user?.username ?? 'guest', ip, action: kind, target: rel, detail: destRel })
    } catch (e: any) {
      failed.push({ path: rel, error: e?.message ?? 'ทำรายการไม่สำเร็จ' })
    }
  }
  return { done, failed }
}
