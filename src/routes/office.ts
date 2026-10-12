import { lstatSync } from 'node:fs'
import { basename } from 'node:path'
import { Elysia, t } from 'elysia'
import { audit } from '../audit'
import { context, need, requireUser } from '../context'
import { forbidden, HttpError, normRel, notFound, resolveIn, storagePath } from '../fsx'
import { log } from '../logger'
import { langOf } from '../messages'
import { callbackData, editorConfig, readToken, requireEnabled, saveVersion, serverJwt, tokenFile } from '../office'
import { fileResponse } from './files'

/**
 * ONLYOFFICE Docs (see office.ts). /config is the page's call (session and CSRF as usual); /file and /callback are
 * called by the document server itself, without a session: the token in the path and the server's JWT stand in.
 */
export const officeRoutes = new Elysia({ prefix: '/api/office' })
  .use(context)

  .post('/config', ({ user, ip, body, request }) => {
    const u = requireUser({ user, ip })
    requireEnabled()
    // the editor shows the whole file, so editing needs the rights to read it too
    const a = body.mode === 'edit' ? need({ user, ip }, body.space, 'read', 'download', 'write') : need({ user, ip }, body.space, 'read', 'download')
    const rel = normRel(body.path)
    const abs = resolveIn(a.root, rel)
    let st
    try { st = lstatSync(abs) } catch { throw notFound() }
    if (!st.isFile()) throw notFound()
    const answer = editorConfig(u, a.space, rel, abs, body.mode, langOf(request))
    audit({ user: u.username, ip, action: 'office-open', target: storagePath(abs), detail: body.mode === 'edit' ? 'แก้ไข' : 'ดู' })
    return answer
  }, { body: t.Object({ space: t.String(), path: t.String(), mode: t.Union([t.Literal('edit'), t.Literal('view')]) }) })

  // the document server fetches the file to open; with JWT enabled it always sends "Authorization: Bearer <jwt>"
  .get('/file/:token', ({ params, request }) => {
    requireEnabled()
    if (!serverJwt(request)) throw forbidden('office.bad-jwt')
    const { abs } = tokenFile(readToken(params.token), ['read', 'download'])
    return fileResponse(abs, basename(abs), request, false)
  })

  // status 1 editing, 2 ready to save, 3 save error, 4 closed without changes, 6 forced save, 7 forced save error
  .post('/callback/:token', async ({ params, body, request, ip }) => {
    requireEnabled()
    const token = readToken(params.token)
    // a viewer's link never saves anything
    if (token.m !== 'edit') throw forbidden('office.bad-token')
    const data = callbackData(body, request)
    if (!data) throw forbidden('office.bad-jwt')
    const status = Number(data.status)
    if (status === 2 || status === 6) {
      try {
        const saved = await saveVersion(token, data)
        audit({
          user: saved.user.username, ip, action: 'office-save', target: storagePath(saved.abs),
          detail: `${status === 6 ? 'บันทึกระหว่างแก้ไข, ' : ''}${saved.size} ไบต์ (ฉบับเดิมอยู่ในถังขยะ)`,
        })
        return { error: 0 }
      } catch (err) {
        // the document server keeps the changes and tells the user saving failed
        const detail = { user: token.u, target: token.f, status, error: err instanceof HttpError ? err.code : err }
        if (err instanceof HttpError) log.warn('office-save-refused', detail)
        else log.error('office-save-failed', detail)
        return { error: 1 }
      }
    }
    if (status === 3 || status === 7) log.warn('office-server-save-error', { user: token.u, target: token.f, status })
    return { error: 0 }
  })
