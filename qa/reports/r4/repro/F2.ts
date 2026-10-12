// F2: POST /api/admin/backups/restore accepts any password (confirmPassword never called)
process.env.FC_SUPERVISED = '1'
import { boot, login, req, finish, ADMIN_PW } from './helper'

const { app } = await boot()
const admin = await login(app, 'admin', ADMIN_PW)
const b = await req(app, admin, 'POST', '/api/admin/backups')
if (b.status !== 200) { console.log('backup create failed', b.status, b.text); process.exit(1) }
const r = await req(app, admin, 'POST', '/api/admin/backups/restore', { name: b.json.name, password: 'definitely-wrong-password' })
finish(r.status === 200 && r.json?.ok === true, `restore with wrong password status=${r.status} ${r.text.slice(0, 120)}`)
