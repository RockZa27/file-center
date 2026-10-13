// F4: upload-request share links bypass the visitors' daily allowance (GUEST_UPLOAD_DAILY_BYTES).
// Control: an anonymous, unauthenticated upload to /api/upload/ (direct guest upload in public space)
// is capped at the configured daily allowance and refused with 429 once exceeded.
// Defect: the same anonymous visitor, using an upload-request share link instead
// (POST /api/s/:token/upload), can keep uploading past that same allowance because initUpload()
// is called without `guest: true` for share uploads (see src/routes/shares.ts).
process.env.GUEST_UPLOAD_DAILY_BYTES = '2000' // 2 KB/day allowance, tiny and deterministic
import { setupEnv, session, loginAdmin, createUser } from './helper'

setupEnv('f4')

async function uploadDirect(app: any, cookie: string, csrf: string, size: number) {
  const announce = await app.handle(new Request('http://localhost/api/upload/', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf },
    body: JSON.stringify({ space: 'public', path: '/', name: `direct-${Date.now()}-${Math.random()}.bin`, size }),
  }))
  return announce
}

async function main() {
  const { app, cookie: sessCookie, csrf: sessCsrf } = await session()
  const admin = await loginAdmin(app, sessCookie, sessCsrf)

  // grant guests 'upload' on the public space so the control (direct anonymous upload) is reachable
  const settingsRes = await app.handle(new Request('http://localhost/api/admin/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie: admin.cookie, 'x-csrf-token': admin.csrf },
    body: JSON.stringify({ guestPermissions: ['read', 'download', 'batchdownload', 'upload', 'write'] }),
  }))
  if (settingsRes.status !== 200) { console.error('settings update failed', settingsRes.status, await settingsRes.text()); process.exit(1) }

  // control: anonymous direct upload announce to public space, well over the 2000-byte daily allowance
  const { app: appAnon, cookie: anonCookie, csrf: anonCsrf } = await session()
  const over = await uploadDirect(appAnon, anonCookie, anonCsrf, 5000)
  if (over.status !== 429) {
    console.error('control failed: direct anonymous upload over the daily allowance was not blocked', over.status, await over.text())
    process.exit(1)
  }
  console.error('control OK: direct anonymous upload over allowance got 429 as expected')

  // owner (a normal user) creates an upload-request share link on their home folder, no limits set
  await createUser(app, admin.cookie, admin.csrf, 'owner4', 'OwnerPassw0rd!9', {
    permissions: ['read', 'write', 'upload', 'download', 'share'],
  })
  const { app: appOwner, cookie: oSessCookie, csrf: oSessCsrf } = await session()
  const ownerLogin = await appOwner.handle(new Request('http://localhost/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: oSessCookie, 'x-csrf-token': oSessCsrf },
    body: JSON.stringify({ username: 'owner4', password: 'OwnerPassw0rd!9' }),
  }))
  const oCookie = (ownerLogin.headers.get('set-cookie') ?? '').split(';')[0]
  const oCsrf = (await ownerLogin.json() as any).csrf

  const mkdirRes = await appOwner.handle(new Request('http://localhost/api/mkdir', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: oCookie, 'x-csrf-token': oCsrf },
    body: JSON.stringify({ space: 'home', path: '/', name: 'uploads' }),
  }))
  if (mkdirRes.status !== 200) { console.error('mkdir failed', mkdirRes.status, await mkdirRes.text()); process.exit(1) }

  const shareRes = await appOwner.handle(new Request('http://localhost/api/shares', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: oCookie, 'x-csrf-token': oCsrf },
    body: JSON.stringify({ space: 'home', path: '/uploads', days: 1, kind: 'upload' }),
  }))
  if (shareRes.status !== 200) {
    console.error('share creation failed', shareRes.status, await shareRes.text())
    process.exit(1)
  }
  const { token } = await shareRes.json() as any

  // anonymous visitor uploads several files through the share link, each under the per-file cap (none set anyway),
  // but together far exceeding the 2000-byte guest daily allowance that applies to direct uploads.
  let totalUploaded = 0
  let blocked = false
  let visitorCookie = ''
  for (let i = 0; i < 5; i++) {
    const size = 5000 // 5KB each, 25KB total >> 2000-byte daily allowance
    const announceRes = await appOwner.handle(new Request(`http://localhost/api/s/${token}/upload`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(visitorCookie ? { cookie: visitorCookie } : {}) },
      body: JSON.stringify({ name: `via-share-${i}.bin`, size }),
    }))
    if (announceRes.status === 429 || announceRes.status === 403) { blocked = true; break }
    if (announceRes.status !== 200) {
      console.error('unexpected share-upload status', announceRes.status, await announceRes.text())
      process.exit(1)
    }
    const setCookie = announceRes.headers.get('set-cookie')
    if (setCookie) visitorCookie = setCookie.split(';')[0]
    const { id, chunkSize } = await announceRes.json() as any

    const chunkData = new Uint8Array(size).fill(65)
    const putRes = await appOwner.handle(new Request(`http://localhost/api/s/${token}/upload/${id}/0`, {
      method: 'PUT',
      headers: { cookie: visitorCookie },
      body: chunkData,
    }))
    if (putRes.status !== 200) { console.error('chunk put failed', putRes.status, await putRes.text()); process.exit(1) }

    const completeRes = await appOwner.handle(new Request(`http://localhost/api/s/${token}/upload/${id}/complete`, {
      method: 'POST',
      headers: { cookie: visitorCookie },
    }))
    if (completeRes.status !== 200) { console.error('complete failed', completeRes.status, await completeRes.text()); process.exit(1) }

    totalUploaded += size
  }

  console.error('total announced via share upload link (bytes):', totalUploaded, 'allowance:', process.env.GUEST_UPLOAD_DAILY_BYTES)
  if (!blocked && totalUploaded > Number(process.env.GUEST_UPLOAD_DAILY_BYTES)) {
    console.error('DoS/quota-bypass confirmed: share-link uploads exceeded the guest daily allowance with no block')
    process.exit(42)
  }
  console.error('share uploads were throttled like direct guest uploads: not confirmed')
  process.exit(0)
}

main()
