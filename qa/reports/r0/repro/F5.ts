import { call, login, run, ADMIN_PW } from './_h'
// Update apply/rollback must verify the admin password (wrong password -> 403).
// Use a bogus package id so nothing is installed: past the password gate the answer is 404 (no such package).
run(async () => {
  const admin = await login('admin', ADMIN_PW)
  const apply = await call('POST', '/api/admin/update/apply', admin, { id: '0000000000000000', password: 'definitely-wrong' })
  const rb = await call('POST', '/api/admin/update/rollback', admin, { dir: 'nonexistent-release', password: 'definitely-wrong' })
  console.log('apply wrong pw ->', apply.status, apply.text.slice(0, 80), '| rollback wrong pw ->', rb.status, rb.text.slice(0, 80))
  // safe code answers 403 (wrong password) before it even looks at the package
  return apply.status !== 403 && rb.status !== 403 && apply.status === 404 && rb.status === 404
})
