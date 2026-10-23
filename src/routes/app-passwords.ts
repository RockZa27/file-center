import { Elysia, t } from 'elysia'
import { audit } from '../audit'
import { APP_PASSWORDS_PER_USER, appPasswordsOf, createAppPassword, publicAppPassword, removeAppPassword } from '../app-passwords'
import { confirmPassword } from '../auth'
import { config } from '../config'
import * as policy from '../policy'
import { context, requireUser } from '../context'
import { bad, notFound } from '../fsx'

/**
 * The signed-in user's app passwords for WebDAV (app-passwords.ts). Made with the account password typed again (a stolen
 * session must not be able to hand itself a password that outlives the session); the secret is in that one answer only.
 */
export const appPasswordRoutes = new Elysia({ prefix: '/api/me/app-passwords' })
  .use(context)

  .get('/', ({ user, ip }) => {
    const u = requireUser({ user, ip })
    return { items: appPasswordsOf(u.username).map(publicAppPassword), max: APP_PASSWORDS_PER_USER, enabled: policy.webdav() }
  })

  .post('/', async ({ user, ip, body }) => {
    const u = requireUser({ user, ip })
    const name = body.name.trim()
    if (!name || name.length > 60) throw bad('auth.app-password-bad-name')
    if (body.scope !== 'read' && body.scope !== 'readwrite') throw bad('auth.app-password-bad-scope')
    if (appPasswordsOf(u.username).length >= APP_PASSWORDS_PER_USER) throw bad('auth.app-password-limit', { max: APP_PASSWORDS_PER_USER })
    await confirmPassword(u, ip, body.password, 'app-password-denied')
    const { item, secret } = await createAppPassword(u, name, body.scope)
    audit({ user: u.username, ip, action: 'app-password-create', target: item.name, detail: item.scope })
    return { ...publicAppPassword(item), secret }
  }, { body: t.Object({ name: t.String({ maxLength: 200 }), scope: t.String({ maxLength: 20 }), password: t.String({ maxLength: 1000 }) }) })

  .delete('/:id', ({ user, ip, params }) => {
    const u = requireUser({ user, ip })
    const gone = removeAppPassword(u.username, params.id)
    if (!gone) throw notFound('auth.app-password-not-found')
    audit({ user: u.username, ip, action: 'app-password-delete', target: gone.name, detail: gone.scope })
    return { ok: true }
  })
