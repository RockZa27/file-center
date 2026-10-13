import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import { setup } from './helper'
const h = await setup()
// the key is made on first use of an office link; here it exists in DATA_DIR as it would in a running install
const { paths } = await import('../../src/config')
writeFileSync(paths.officeKey, 'A'.repeat(43), { mode: 0o600 })
const b = await h.call(h.admin, 'POST', '/api/admin/backups')
console.log('backup', b.status, b.text.slice(0, 100))
const d = await h.app.handle(new Request(`http://localhost/api/admin/backups/${b.json.name}/download`, { headers: { cookie: h.admin.cookie } }))
const buf = Buffer.from(await d.arrayBuffer())
const hasKey = buf.includes(Buffer.from('office-links.key'))
const hasSecret = buf.includes(Buffer.from('secret.key'))
console.log('zip bytes', buf.length, 'office key in zip', hasKey, 'secret.key in zip', hasSecret)
process.exit(hasKey ? 42 : 0)
