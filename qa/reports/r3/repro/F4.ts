// F4: a symlink inside the public space must not let a guest read a file outside the space
import { mkdirSync, writeFileSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { setup, client, done } from './helper'
const { app, storage, base } = await setup()
const c = client(app)
const outside = join(base, 'outside')
mkdirSync(outside)
writeFileSync(join(outside, 'secret.txt'), 'OUTSIDE-SECRET')
symlinkSync(outside, join(storage, 'public', 'link'))
const guest = await c.session()
const r = await c.req('GET', '/api/download?space=public&path=/link/secret.txt', guest)
const t = await r.text()
console.log('status', r.status, t.slice(0, 60))
done(r.status === 200 && t.includes('OUTSIDE-SECRET'), `download through symlink -> ${r.status}`)
