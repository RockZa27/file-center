// F4: GET /api/download checks only 'read', not 'download'. A user whose public permissions are ['read']
// (list only, no download) can still stream the full file. Every other content route also requires 'download'.
import { join } from 'node:path'
import { prepEnv, importApp, loginAdmin, createUser, login } from './helper'

const SECRET = 'PDF-SECRET-' + Math.random().toString(36).slice(2)
const base = prepEnv()
// a real file in the public space
await Bun.write(join(base, 'storage', 'public', 'secret.pdf'), SECRET)

const app = await importApp()
const admin = await loginAdmin(app)

// a normal user allowed to LIST public but NOT download
await createUser(app, admin, {
  username: 'lister', name: 'Lister', password: 'Zx9q-strong-pw-4821', role: 'user',
  homedir: '/lister', permissions: ['read'], publicPermissions: ['read'],
})
const user = await login(app, 'lister', 'Zx9q-strong-pw-4821')

const r = await app.handle(new Request('http://localhost/api/download?space=public&path=/secret.pdf', {
  headers: { cookie: user.cookie },
}))
console.log('download status', r.status)

if (r.status === 200) {
  const text = await r.text()
  if (text === SECRET) {
    console.log('CONFIRMED: file streamed to a user who only has read (list), not download')
    process.exit(42)
  }
  console.log('200 but body mismatch:', JSON.stringify(text.slice(0, 40)))
  process.exit(0)
}
console.log('safe: download refused for a read-only user')
process.exit(0)
