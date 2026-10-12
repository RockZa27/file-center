// F6: searchTree uses stat (follows links), so a guest search lists entries under a linked folder outside the root
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { base, boot, guest, req, finish } from './helper'

const { app, paths } = await boot()
const outside = join(base, 'outside')
mkdirSync(join(outside, 'deep'), { recursive: true })
writeFileSync(join(outside, 'deep', 'zz-hidden-payroll.txt'), 'x'.repeat(1234))
writeFileSync(join(paths.publicDir, 'zz-hidden-visible.txt'), 'y') // control: a normal file the search must find
// precondition (no route creates links): a link in the public folder pointing outside the storage root
symlinkSync(outside, join(paths.publicDir, 'shortcut'))
const g = await guest(app)
const r = await req(app, g, 'GET', '/api/search?space=public&q=zz-hidden')
const names = (r.json?.results ?? []).map((e: any) => e.path)
console.log('search:', r.status, JSON.stringify(names))
if (!names.includes('/zz-hidden-visible.txt')) { console.log('control file not found; search did not work'); process.exit(1) }
finish(names.some((p: string) => p.includes('payroll')), 'guest search listed a file reached through a link outside the root')
