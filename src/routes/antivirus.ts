import { Elysia } from 'elysia'
import { antivirusOn, deleteQuarantined, lastCheck, listQuarantine, releaseQuarantined, testConnection } from '../antivirus'
import { audit } from '../audit'
import { context, requireAdmin } from '../context'
import { HttpError } from '../fsx'
import * as policy from '../policy'

/** /api/admin/antivirus: the scanner's state, the quarantine list and the connection test. Admins only. */
export const antivirusRoutes = new Elysia({ prefix: '/admin/antivirus' })
  .use(context)

  .get('/', ({ user, ip }) => {
    requireAdmin({ user, ip })
    const v = policy.antivirusValues()
    return { enabled: v.enabled, host: v.host, port: v.port, lastCheck: { ...lastCheck }, quarantined: listQuarantine().length }
  })

  // the EICAR test string through INSTREAM: proves clamd is reached and has its signatures
  .post('/test', async ({ user, ip }) => {
    const admin = requireAdmin({ user, ip })
    const r = await testConnection()
    audit({ user: admin.username, ip, action: 'antivirus-test', detail: r.ok && r.detected ? 'ok' : r.reason ?? 'failed' })
    if (!r.ok && r.reason === 'timeout') throw new HttpError(504, 'antivirus.test-timeout')
    if (!r.ok && r.reason === 'unreachable') throw new HttpError(502, 'antivirus.test-unreachable')
    if (!r.detected) throw new HttpError(502, 'antivirus.not-detected')
    return { ok: true, signature: r.signature ?? '', enabled: antivirusOn() }
  })

  .get('/quarantine', ({ user, ip }) => {
    requireAdmin({ user, ip })
    // never a server path: the id, what the uploader called it and where it was going
    return { items: listQuarantine() }
  })

  .delete('/quarantine/:id', ({ user, ip, params }) => {
    const admin = requireAdmin({ user, ip })
    const m = deleteQuarantined(params.id)
    audit({ user: admin.username, ip, action: 'quarantine-delete', target: `quarantine:${m.id}`, detail: `${m.signature}: ${m.name.slice(0, 200)}` })
    return { ok: true }
  })

  // the admin decided it is a false alarm: the file goes where it was meant to go, and is not scanned again
  .post('/quarantine/:id/release', async ({ user, ip, params }) => {
    const admin = requireAdmin({ user, ip })
    const { path, meta } = await releaseQuarantined(params.id)
    audit({ user: admin.username, ip, action: 'quarantine-release', target: `quarantine:${meta.id}`, detail: `${meta.signature}: ${meta.name.slice(0, 200)}` })
    return { ok: true, name: path.split(/[\\/]/).pop() }
  })
