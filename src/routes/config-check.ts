import { Elysia, t } from 'elysia'
import { audit } from '../audit'
import { configWarnings } from '../config-warnings'
import { context, requireAdmin } from '../context'
import { bad, conflict, HttpError } from '../fsx'
import { cleanAddress, MailError, sendMail, smtpConfig } from '../mail'
import { langOf, text } from '../messages'
import { verifiedEmailOf } from '../notify'

/** one test mail per admin in this many ms: it is a button, not a way to send mail at will */
export const MAIL_TEST_EVERY_MS = 10_000
const lastTest = new Map<string, number>()

export const configRoutes = new Elysia({ prefix: '/admin' })
  .use(context)

  // risky or odd .env values, for the settings page
  .get('/config-warnings', ({ user, ip, request }) => {
    requireAdmin({ user, ip })
    const lang = langOf(request)
    return { items: configWarnings(request).map(w => ({ ...w, message: text(lang, w.code) })) }
  })

  // a test message with the e-mail settings in force: to the given address, else the admin's confirmed one
  .post('/mail/test', async ({ user, ip, body, request }) => {
    const admin = requireAdmin({ user, ip })
    const lang = langOf(request)
    const wait = (lastTest.get(admin.username) ?? 0) + MAIL_TEST_EVERY_MS - Date.now()
    if (wait > 0) throw new HttpError(429, 'admin.mail-test-wait', { seconds: Math.ceil(wait / 1000) })
    if (!smtpConfig().enabled) throw conflict('notify.email-off')
    const to = body.to ? cleanAddress(body.to) : verifiedEmailOf(admin.username)
    if (body.to && !to) throw bad('notify.bad-address')
    if (!to) throw bad('admin.mail-test-no-address')
    lastTest.set(admin.username, Date.now())
    try {
      await sendMail({ to, subject: text(lang, 'admin.mail-test-subject'), text: text(lang, 'admin.mail-test-body') })
    } catch (e) {
      audit({ user: admin.username, ip, action: 'mail-test', detail: 'failed' })
      // a MailError never holds the password or an address
      throw new HttpError(502, 'admin.mail-test-failed', { reason: e instanceof MailError ? e.message : 'cannot connect' })
    }
    audit({ user: admin.username, ip, action: 'mail-test', detail: 'ok' })
    return { ok: true }
  }, { body: t.Object({ to: t.Optional(t.String({ maxLength: 320 })) }) })
