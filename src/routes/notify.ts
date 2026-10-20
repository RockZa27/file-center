import { Elysia, t } from 'elysia'
import { findUser } from '../auth'
import { context, requireUser } from '../context'
import { enqueue } from '../deliver'
import { HttpError, notFound } from '../fsx'
import { issueLinkCode, LINK_CODE_TTL_MS, lineEnabled, lineReply, lineWebhookEnabled, redeemLinkCode, validSignature } from '../line'
import { langOf, text } from '../messages'
import {
  accountOfLine, langOfUser, linkLine, listNotifications, markRead, prefsOf, rememberLang, removeEmail, removeNotification,
  render, requestEmailVerification, setPrefs, unlinkLine, verifyEmail,
} from '../notify'

const LINE_BODY_MAX = 1024 * 1024
const channels = t.Object({ web: t.Optional(t.Boolean()), email: t.Optional(t.Boolean()), line: t.Optional(t.Boolean()) })

/** one event of LINE's webhook: a code sent to the bot links the sender, "unfollow" (blocked or removed the bot) unlinks */
function lineEvent(ev: any) {
  const lineUser = ev?.source?.userId
  if (typeof lineUser !== 'string' || !lineUser) return
  const replyToken = typeof ev.replyToken === 'string' ? ev.replyToken : null
  const answer = (message: string) => { if (replyToken) enqueue('line', () => lineReply(replyToken, message)) }
  if (ev.type === 'unfollow') {
    const name = accountOfLine(lineUser)
    if (name) unlinkLine(name)
    return
  }
  if (ev.type !== 'message' || ev.source?.type !== 'user' || ev.message?.type !== 'text' || typeof ev.message.text !== 'string') return
  const code = ev.message.text.trim()
  if (!/^\d{6}$/.test(code)) return
  const who = redeemLinkCode(code, lineUser)
  if (who === 'locked') return
  const user = who ? findUser(who) : undefined
  if (!user) return answer(`${text('th', 'notify.line-bad-code')}\n${text('en', 'notify.line-bad-code')}`)
  const lang = langOfUser(user.username)
  answer(linkLine(user.username, lineUser)
    ? text(lang, 'notify.line-linked', { name: user.name || user.username })
    : text(lang, 'notify.line-taken'))
}

/** the signed-in user's bell, e-mail and LINE settings, and LINE's webhook (which has no session: it is signed) */
export const notifyRoutes = new Elysia({ prefix: '/api' })
  .use(context)

  // ───────────── the bell ─────────────
  .get('/me/notifications', ({ user, ip, query, request }) => {
    const u = requireUser({ user, ip })
    const lang = langOf(request)
    const { items, unread } = listNotifications(u.username, query.unreadOnly === 'true' || query.unreadOnly === '1')
    return { items: items.map(n => render(n, lang)), unread }
  }, { query: t.Object({ unreadOnly: t.Optional(t.String()) }) })

  // no ids = all of them
  .post('/me/notifications/read', ({ user, ip, body }) => {
    const u = requireUser({ user, ip })
    return { ok: true, unread: markRead(u.username, body?.ids) }
  }, { body: t.Optional(t.Object({ ids: t.Optional(t.Array(t.String({ maxLength: 64 }), { maxItems: 200 })) })) })

  .delete('/me/notifications/:id', ({ user, ip, params }) => {
    const u = requireUser({ user, ip })
    if (!removeNotification(u.username, params.id)) throw notFound('notify.not-found')
    return { ok: true }
  })

  // ───────────── settings ─────────────
  .get('/me/notify-prefs', ({ user, ip }) => prefsOf(requireUser({ user, ip })))

  .put('/me/notify-prefs', ({ user, ip, body, request }) => {
    const u = requireUser({ user, ip })
    rememberLang(u.username, langOf(request))
    setPrefs(u, body)
    return prefsOf(u)
  }, { body: t.Object({ lang: t.Optional(t.Union([t.Literal('th'), t.Literal('en')])), events: t.Optional(t.Record(t.String(), channels)) }) })

  // ───────────── e-mail ─────────────
  .put('/me/email', ({ user, ip, body, request }) => {
    const u = requireUser({ user, ip })
    rememberLang(u.username, langOf(request))
    return requestEmailVerification(u, body.address)
  }, { body: t.Object({ address: t.String({ maxLength: 320 }) }) })

  .delete('/me/email', ({ user, ip }) => {
    removeEmail(requireUser({ user, ip }).username)
    return { ok: true }
  })

  // the link in the verification mail: the token is the proof, so it needs no session (the mail may be opened on a phone)
  .get('/me/email/verify', ({ query, request }) => {
    // the page's own fetch (it sends x-lang) gets JSON; a click in the mail program is a navigation and lands on the app
    const wantsJson = request.headers.has('x-lang') || (request.headers.get('accept') ?? '').includes('application/json')
    try {
      const username = verifyEmail(query.token)
      if (wantsJson) return { ok: true, username }
      return new Response(null, { status: 302, headers: { location: '/?emailVerified=1', 'cache-control': 'no-store' } })
    } catch (e) {
      if (wantsJson || !(e instanceof HttpError)) throw e
      return new Response(null, { status: 302, headers: { location: '/?emailVerified=0', 'cache-control': 'no-store' } })
    }
  }, { query: t.Object({ token: t.Optional(t.String({ maxLength: 200 })) }) })

  // ───────────── LINE ─────────────
  .post('/me/line/link', ({ user, ip, request }) => {
    const u = requireUser({ user, ip })
    if (!lineEnabled() || !lineWebhookEnabled()) throw new HttpError(409, 'notify.line-off')
    rememberLang(u.username, langOf(request))
    return { ...issueLinkCode(u.username), ttlSeconds: LINK_CODE_TTL_MS / 1000 }
  })

  .delete('/me/line', ({ user, ip }) => {
    unlinkLine(requireUser({ user, ip }).username)
    return { ok: true }
  })

  // LINE calls this; the signature of the raw body (X-Line-Signature, HMAC-SHA256 with the channel secret) is the only way in
  .post('/line/webhook', async ({ request }) => {
    const raw = new Uint8Array(await request.arrayBuffer())
    if (raw.length > LINE_BODY_MAX) throw new HttpError(413, 'request.too-big')
    if (!validSignature(raw, request.headers.get('x-line-signature'))) throw new HttpError(401, 'notify.bad-signature')
    let events: unknown[] = []
    try { events = JSON.parse(new TextDecoder().decode(raw))?.events ?? [] } catch { /* a signed body that is no JSON: nothing to do */ }
    if (Array.isArray(events)) for (const ev of events.slice(0, 50)) lineEvent(ev)
    return { ok: true }
  }, { parse: 'none' })
