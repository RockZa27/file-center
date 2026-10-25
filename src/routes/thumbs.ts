import { Elysia, t } from 'elysia'
import { auditOnce } from '../audit'
import { isForeignSpace } from '../auth'
import { context, need, requireUser } from '../context'
import { HttpError, normRel, resolveIn, storagePath } from '../fsx'
import { etagMatches } from '../static'
import { planThumb, thumbFile, thumbStatus } from '../thumbs'
import { startDownload } from '../shares'
import { shareFile } from './shares'

/**
 * The picture for a file the caller may already see (the routes below check that first). 304 when the browser holds
 * this version of the thumbnail; 404 `thumb.unavailable` when there is none to make (the page shows an icon);
 * 503 + Retry-After when too many are waiting to be made.
 */
async function thumbResponse(abs: string, sizeQuery: string | undefined, request: Request, set: { headers: any }): Promise<Response> {
  const plan = planThumb(abs, storagePath(abs), sizeQuery === undefined ? 256 : Number(sizeQuery))
  const etag = `"${plan.key}"`
  const headers: Record<string, string> = {
    'Content-Type': plan.mime,
    'ETag': etag,
    // the picture of one version of a file never changes (the key has its size and time in it), but it is for this browser only
    'Cache-Control': 'private, max-age=86400',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
  }
  if (etagMatches(request.headers.get('if-none-match'), etag)) return new Response(null, { status: 304, headers })
  let file: string
  try {
    file = await thumbFile(plan)
  } catch (err) {
    if (err instanceof HttpError && err.status === 503) set.headers['retry-after'] = '3'
    throw err
  }
  return new Response(Bun.file(file), { headers })
}

const sizeQ = t.Optional(t.String({ maxLength: 8 }))

export const thumbRoutes = new Elysia({ prefix: '/api' })
  .use(context)

  // which kinds this server can make a picture of; the file list shows icons for the others without asking
  .get('/thumbs/status', ({ user, ip }) => {
    requireUser({ user, ip })
    return thumbStatus()
  })

  .get('/thumb', ({ user, ip, query, request, set }) => {
    // 1024 px is nearly the file itself: it needs the right to download, 256 px only the right to read
    const a = Number(query.size) === 1024 ? need({ user, ip }, query.space, 'read', 'download') : need({ user, ip }, query.space, 'read')
    const abs = resolveIn(a.root, normRel(query.path))
    // a picture of a file in a managed user's home leaves a line (once a minute per file), like browsing a folder there
    if (user && isForeignSpace(a.space)) {
      auditOnce(`browse|${user.username}|${a.space}|${storagePath(abs)}`, { user: user.username, ip, action: 'browse', target: storagePath(abs), detail: a.space })
    }
    return thumbResponse(abs, query.size, request, set)
  }, { query: t.Object({ space: t.String(), path: t.String(), size: sizeQ }) })

  // a folder link: the same checks as its download (a used-up or expired link is 404, and every link here is a download
  // link, so 1024 is fine). 256 px is a preview and counts nothing; 1024 px is nearly the file itself, so on a link with a
  // download limit it takes one download, counted once the picture is sent (a repeat the browser already holds, 304, is free)
  .get('/s/:token/thumb', async ({ params, query, request, set }) => {
    const { share, abs } = shareFile(params.token, query.path, request)
    if (Number(query.size) !== 1024 || share.maxDownloads === null) return thumbResponse(abs, query.size, request, set)
    const slot = startDownload(share)
    try {
      const res = await thumbResponse(abs, query.size, request, set)
      if (res.status === 200) slot.finish(); else slot.release()
      return res
    } catch (err) {
      slot.release()
      throw err
    }
  }, { query: t.Object({ path: t.Optional(t.String()), size: sizeQ }) })
