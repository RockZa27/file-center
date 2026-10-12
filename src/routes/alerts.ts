import { Elysia } from 'elysia'
import { alertStatus, sendTestAlert } from '../alerts'
import { audit } from '../audit'
import { context, requireAdmin } from '../context'
import { HttpError } from '../fsx'

export const alertRoutes = new Elysia({ prefix: '/admin/alerts' })
  .use(context)

  // whether alerts are on, where they go (host only) and when each kind last went out
  .get('/', ({ user, ip }) => {
    requireAdmin({ user, ip })
    return alertStatus()
  })

  // send a test message now and answer whether it arrived
  .post('/test', async ({ user, ip }) => {
    const admin = requireAdmin({ user, ip })
    try {
      await sendTestAlert()
    } catch (e) {
      audit({ user: admin.username, ip, action: 'alert-test', detail: e instanceof HttpError ? e.code : 'error' })
      throw e
    }
    audit({ user: admin.username, ip, action: 'alert-test', detail: 'ok' })
    return { ok: true }
  })
