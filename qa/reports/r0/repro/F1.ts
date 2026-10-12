import { call, login, makeUser, run, ADMIN_PW } from './_h'
// A normal user must get 403 from the admin API. Vulnerable: 200 and a new admin account appears.
run(async () => {
  const admin = await login('admin', ADMIN_PW)
  await makeUser(admin, 'alice')
  const alice = await login('alice', 'UserPass-12345')
  const list = await call('GET', '/api/admin/users', alice)
  const create = await call('POST', '/api/admin/users', alice, {
    username: 'evil', name: 'evil', password: 'EvilPass-12345', role: 'admin', permissions: [], publicPermissions: [],
  })
  console.log('GET /api/admin/users as alice ->', list.status, '| POST create admin ->', create.status)
  let escalated = false
  if (create.status === 200) {
    const evil = await login('evil', 'EvilPass-12345')
    escalated = (await call('GET', '/api/admin/users', evil)).status === 200
  }
  return list.status === 200 && create.status === 200 && escalated
})
