// F7: symlinks inside a shared folder are followed by /api/s/:token?path= and /download?path=
import { mkdirSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { adminLogin, call, done, makeUser, putFile, share } from './helper'
const admin = await adminLogin()
const bob = await makeUser(admin, 'bob')
for (const d of ['shared', 'shared/sub', 'private']) {
  const parent = d.includes('/') ? '/' + d.split('/').slice(0, -1).join('/') : '/'
  const r = await call('POST', '/api/mkdir', bob.sess, { space: 'home', path: parent, name: d.split('/').pop() })
  if (r.status !== 200) throw new Error(`mkdir ${d} ${r.status}`)
}
await putFile(bob.sess, '/shared/sub', 'in.txt', 'inside-share')
await putFile(bob.sess, '/private', 'secret.txt', 'outside-share')
const home = join(process.env.STORAGE_DIR!, 'users', 'bob')
// no API makes links: placed on disk (e.g. by an unzip-less copy, a shell user, a mounted folder)
symlinkSync(join(home, 'shared', 'sub'), join(home, 'shared', 'inlink'))
symlinkSync(join(home, 'private'), join(home, 'shared', 'outlink'))
const token = await share(bob.sess, '/shared')
const inList = await call('GET', `/api/s/${token}?path=inlink`)
const inDl = await call('GET', `/api/s/${token}/download?path=inlink/in.txt`)
const inBody = await inDl.text()
const outList = await call('GET', `/api/s/${token}?path=outlink`)
const outDl = await call('GET', `/api/s/${token}/download?path=outlink/secret.txt`)
const outBody = await outDl.text()
console.log('list via inside link:', inList.status, ' download via inside link:', inDl.status, JSON.stringify(inBody))
console.log('list via outside link:', outList.status, ' download via outside link:', outDl.status, JSON.stringify(outBody.slice(0, 60)))
if (outDl.status === 200 && outBody === 'outside-share') console.log('NOTE: link escapes the shared folder')
done(inDl.status === 200 && inBody === 'inside-share', 'symlink path segment inside the share is followed')
