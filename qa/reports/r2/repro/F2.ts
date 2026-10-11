// F2: guest access to the public folder ignores publicEnabled.
// Admin turns the public page off; an anonymous visitor must then be denied (401/403).
// Vulnerable: GET /api/list?space=public still returns 200 for a guest.
import { setupEnv, importApp, login, send, get, anon, fail, pass, vuln } from './helpers'

setupEnv({ adminPassword: 'adminPassw0rd!' })
const app = await importApp()

const admin = await login(app, 'admin', 'adminPassw0rd!')
const off = await send(app, 'PUT', '/api/admin/settings', admin, { publicEnabled: false })
if (off.status !== 200) fail(`could not disable public page: ${off.status} ${await off.text()}`)

// fresh anonymous visitor
const guest = await anon(app)
const res = await get(app, '/api/list?space=public', guest)
if (res.status === 200) { console.log('guest listed the public folder while it is disabled — 200'); vuln() }
console.log(`guest denied (${res.status}) — safe`); pass()
