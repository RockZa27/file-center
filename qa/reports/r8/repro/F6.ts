import { join } from 'node:path'
import { setup, put } from './helper'
const h = await setup()
const u = await h.mkUser('gus', ['read', 'write', 'upload', 'download'], [])
put(join(h.storage, 'users', 'gus', 'plans.txt'), 'x')
const a = await h.call(u, 'POST', '/api/me/favorites', { space: 'home', path: '/plans.txt' })
const before = await h.call(u, 'GET', '/api/me/favorites')
const up = await h.call(h.admin, 'PUT', '/api/admin/users/gus', { permissions: ['upload'] })
const after = await h.call(u, 'GET', '/api/me/favorites')
const rec = await h.call(u, 'GET', '/api/me/recent')
const rd = await h.call(u, 'GET', '/api/list?space=home&path=/')
console.log(a.status, before.json.items.length, up.status, 'after', after.status, JSON.stringify(after.json), 'direct list', rd.status)
process.exit(rd.status === 403 && after.json?.items?.length > 0 ? 42 : 0)
