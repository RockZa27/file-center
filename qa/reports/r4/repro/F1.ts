// F1: /api/rename only requires 'read', so an anonymous visitor (default guest perms: read/download/batchdownload) can rename public files
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { boot, guest, req, finish } from './helper'

const { app, paths } = await boot()
writeFileSync(join(paths.publicDir, 'report.pdf'), 'data')
const g = await guest(app)
const r = await req(app, g, 'POST', '/api/rename', { space: 'public', path: '/report.pdf', name: 'renamed.pdf' })
const renamed = existsSync(join(paths.publicDir, 'renamed.pdf')) && !existsSync(join(paths.publicDir, 'report.pdf'))
finish(r.status === 200 && renamed, `guest rename status=${r.status} renamed=${renamed}`)
