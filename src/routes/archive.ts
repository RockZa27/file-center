import { existsSync, statSync } from 'node:fs'
import { Elysia, t } from 'elysia'
import { archiveEntryResponse, listArchive } from '../archive'
import { auditOnce } from '../audit'
import { isForeignSpace } from '../auth'
import { context, need } from '../context'
import { normRel, notFound, resolveIn, storagePath } from '../fsx'
import { startDownload } from '../shares'
import { contentDisposition } from './files'
import { counted, settled, shareFile } from './shares'

/** a zip file the caller named, found like a download finds its file */
function zipAt(root: string, path: unknown): string {
  const abs = resolveIn(root, normRel(path))
  if (!existsSync(abs) || !statSync(abs).isFile()) throw notFound()
  return abs
}

const inside = (entry: string) => `ในไฟล์ zip: ${entry.slice(0, 300)}`

export const archiveRoutes = new Elysia({ prefix: '/api' })
  .use(context)

  // ───────────── the entries of a zip, without extracting ─────────────
  .get('/archive/list', async ({ user, ip, query }) => {
    const a = need({ user, ip }, query.space, 'read', 'download')
    const abs = zipAt(a.root, query.path)
    // looking into a managed user's home leaves a line (once a minute per file), like browsing a folder there
    if (user && isForeignSpace(a.space)) {
      auditOnce(`browse|${user.username}|${a.space}|${storagePath(abs)}`, { user: user.username, ip, action: 'browse', target: storagePath(abs), detail: a.space })
    }
    return await listArchive(abs)
  }, { query: t.Object({ space: t.String(), path: t.String() }) })

  // ───────────── one entry ─────────────
  .get('/archive/file', async ({ user, ip, query }) => {
    const a = need({ user, ip }, query.space, 'read', 'download')
    const abs = zipAt(a.root, query.path)
    const res = await archiveEntryResponse(abs, query.entry, query.inline === '1', contentDisposition)
    // like a download: on the trail (once a minute per entry); in someone else's home it also names whose
    auditOnce(`archive|${user?.username ?? 'guest'}|${a.space}|${storagePath(abs)}|${query.entry}`, {
      user: user?.username ?? 'guest', ip, action: 'download', target: storagePath(abs),
      detail: isForeignSpace(a.space) ? `${inside(query.entry)}, ${a.space}` : inside(query.entry),
    })
    return res
  }, { query: t.Object({ space: t.String(), path: t.String(), entry: t.String(), inline: t.Optional(t.String()) }) })

  // ───────────── folder links: download links only, with the link's own checks ─────────────
  .get('/s/:token/archive/list', async ({ params, query, request }) => {
    const { abs } = shareFile(params.token, query.path, request)
    return await listArchive(abs)
  }, { query: t.Object({ path: t.Optional(t.String()) }) })

  .get('/s/:token/archive/file', async ({ params, query, request, user, ip }) => {
    const { share, abs } = shareFile(params.token, query.path, request)
    // an entry taken out of a zip is a download of the link: it counts, and waits for a place like one
    const slot = startDownload(share)
    try {
      const res = await archiveEntryResponse(abs, query.entry, false, contentDisposition)
      auditOnce(`share-archive|${share.id}|${ip}|${storagePath(abs)}|${query.entry}`, {
        user: user?.username ?? 'guest', ip, action: 'share-download', target: storagePath(abs),
        detail: `ลิงก์ ${share.id} ของ ${share.owner}, ${inside(query.entry)}`,
      })
      return share.maxDownloads === null ? settled(res, slot) : counted(res, slot)
    } catch (err) {
      slot.release()
      throw err
    }
  }, { query: t.Object({ path: t.Optional(t.String()), entry: t.String() }) })
