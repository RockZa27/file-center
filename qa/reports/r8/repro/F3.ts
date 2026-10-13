import { join, } from 'node:path'
import { existsSync } from 'node:fs'
import { setup, put } from './helper'
const h = await setup()
const u = await h.mkUser('dave', ['read', 'write', 'upload', 'download'], ['read'])
put(join(h.storage, 'users', 'dave', 'a.bin'), 'data')
const r = await h.call(u, 'POST', '/api/copy', { space: 'home', items: ['/a.bin'], dest: '/', destSpace: 'public' })
const landed = existsSync(join(h.storage, 'public', 'a.bin'))
console.log('copy', r.status, JSON.stringify(r.json), 'landed', landed)
process.exit(landed ? 42 : 0)
