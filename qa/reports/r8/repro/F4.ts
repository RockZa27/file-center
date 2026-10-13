import { join } from 'node:path'
import { setup, put } from './helper'
const h = await setup()
const u = await h.mkUser('erin', ['read', 'write', 'upload', 'download'], [], { quotaBytes: 100_000 })
put(join(h.storage, 'users', 'erin', 'doc.txt'), 'a'.repeat(10_000))
const big = (n: number) => String(n % 10).repeat(10_000)
const used = async () => { for (let i = 0; i < 5; i++) { await h.call(u, 'GET', '/api/usage'); await Bun.sleep(100) } return h.call(u, 'GET', '/api/usage') }
const q = await h.call(u, 'GET', '/api/me/usage'); console.log('probe', q.status)
let last: any
for (let i = 1; i <= 6; i++) {
  const c = await h.call(u, 'GET', '/api/content?space=home&path=/doc.txt')
  last = await h.call(u, 'PUT', '/api/content', { space: 'home', path: '/doc.txt', content: big(i), expectedMtime: c.json.mtime })
  if (last.status !== 200) console.log('put', i, last.status)
}
const vs = await h.call(u, 'GET', '/api/versions?space=home&path=/doc.txt')
const nver = vs.json.items.length
const vbytes = vs.json.items.reduce((s: number, v: any) => s + v.size, 0)
const { usage } = await import('../../src/quota')
const { findUser } = await import('../../src/auth')
const U = findUser('erin')!
const { forget } = await import('../../src/quota'); forget('erin'); usage(U); await Bun.sleep(800); const us = usage(U)
console.log('versions', nver, 'bytes', vbytes, 'usage', JSON.stringify(us))
// the live file is 10000 bytes; versions hold >= 50000 more. Counted usage should include them.
process.exit(nver >= 3 && us.used < 10_000 + vbytes ? 42 : 0)
