import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { setup, put } from './helper'
const h = await setup()
const u = await h.mkUser('fay', ['read', 'write', 'upload', 'download'], [])
const f = join(h.storage, 'users', 'fay', 'ghostfile.txt')
put(f, 'x')
const si = await import('../../src/search-index')
si.indexTouched(f)
await h.waitIndexed(u)
const s1 = await h.call(u, 'GET', '/api/search?space=home&q=ghostfile')
const d = await h.call(u, 'POST', '/api/delete', { space: 'home', items: ['/ghostfile.txt'] })
const s2 = await h.call(u, 'GET', '/api/search?space=home&q=ghostfile')
console.log('before', s1.json.results.length, 'delete', d.status, 'exists', existsSync(f), 'after', s2.json.results.length, s2.json.indexed)
process.exit(s1.json.results.length === 1 && !existsSync(f) && s2.json.results.length > 0 ? 42 : 0)
