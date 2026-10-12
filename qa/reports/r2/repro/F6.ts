// F6: forced password change is enforced only on /api/admin/* routes.
// The bootstrap admin starts with mustChangePassword=true. It must be blocked from every API
// except the password-change routes. Vulnerable: it can still call /api/list (200). Safe: 403.
import { setupEnv, importApp, login, get, fail, pass, vuln } from './helpers'

// No ADMIN_PASSWORD => bootstrap generates one and sets mustChangePassword=true; capture it from the console.
let generated = ''
const realLog = console.log
console.log = (...args: unknown[]) => {
  const line = args.map(String).join(' ')
  const m = /รหัสผ่าน:\s*(\S+)/.exec(line)
  if (m && m[1] !== '(ตามค่า') generated = m[1]
  realLog(...args)
}

setupEnv({ adminPassword: null })
const app = await importApp()
console.log = realLog
if (!generated) fail('could not capture the generated admin password')

const admin = await login(app, 'admin', generated) // login works even with mustChangePassword
const res = await get(app, '/api/list?space=home', admin)
if (res.status === 200) { console.log('must-change admin reached /api/list (200) — enforcement scoped to /api/admin only'); vuln() }
console.log(`must-change admin blocked from /api/list (${res.status}) — safe`); pass()
