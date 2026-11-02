import { Elysia, t } from 'elysia'
import { context, requireUser } from '../context'
import { guideOf, setGuide } from '../guide'

/** the signed-in user's onboarding state: what's-new seen up to which version, and the tours finished */
export const guideRoutes = new Elysia({ prefix: '/api' })
  .use(context)

  .get('/me/guide', ({ user, ip }) => guideOf(requireUser({ user, ip })))

  // the shape is checked in guide.ts (so a bad value answers with a catalog message, not a schema error)
  .put('/me/guide', { body: t.Object({ seenVersion: t.Optional(t.Any()), toursDone: t.Optional(t.Any()) }) }, ({ user, ip, body }) => {
    const u = requireUser({ user, ip })
    setGuide(u.username, body)
    return guideOf(u)
  })
