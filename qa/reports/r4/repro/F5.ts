// F5: copyTree stats children with statSync (follows links), so a link inside a copied folder is copied as real data
import { existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { base, boot, login, makeUser, req, finish, ADMIN_PW } from './helper'

const { app, config } = await boot()
const admin = await login(app, 'admin', ADMIN_PW)
const u = await makeUser(app, admin, 'writer', ['read', 'write', 'download'], [])
const home = join(config.storageDir, 'users', 'writer')
// decoy data outside the storage root (inside this script's temp dir)
const outside = join(base, 'outside')
mkdirSync(outside, { recursive: true })
writeFileSync(join(outside, 'secret.txt'), 'TOP-SECRET-OUTSIDE-ROOT')
// precondition (no route creates links): a folder in the user's home holding a link to outside data
mkdirSync(join(home, 'proj'), { recursive: true })
writeFileSync(join(home, 'proj', 'normal.txt'), 'ok')
symlinkSync(join(outside, 'secret.txt'), join(home, 'proj', 'link.txt'))
symlinkSync(outside, join(home, 'proj', 'linkdir'))
const r = await req(app, u, 'POST', '/api/copy', { space: 'home', items: ['/proj'], dest: '/' })
console.log('copy:', r.status, JSON.stringify(r.json))
const copyDir = join(home, 'proj (1)')
const f = join(copyDir, 'link.txt'), d = join(copyDir, 'linkdir', 'secret.txt')
const leakedFile = existsSync(f) && !lstatSync(f).isSymbolicLink() && readFileSync(f, 'utf8') === 'TOP-SECRET-OUTSIDE-ROOT'
const leakedDir = existsSync(d) && readFileSync(d, 'utf8') === 'TOP-SECRET-OUTSIDE-ROOT'
const g = await req(app, u, 'GET', '/api/content?space=home&path=' + encodeURIComponent('/proj (1)/link.txt'))
console.log('leakedFile', leakedFile, 'leakedDir', leakedDir, 'read via API:', g.status, g.json?.content)
finish(leakedFile || leakedDir, 'link targets outside the root were copied as regular data')
