/**
 * View-only download links: the visitor may preview but every download path refuses (download, zip of a folder, a zip entry,
 * ranges, the 1024 px original-quality route is a preview and stays open), the admin's policy can force or forbid it, and
 * the watermark text is made for the visitor. In-process on the shared app (see in-process-env.ts); users start with "vo-".
 */
import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { zipSync } from 'fflate'
import './in-process-env'

let app: any
let settings: typeof import('../src/settings').settings
let sharesMod: typeof import('../src/shares')

class Client {
  jar = new Map<string, string>()
  csrf = ''
  async raw(method: string, path: string, body?: any, headers: Record<string, string> = {}) {
    const h: Record<string, string> = { ...headers }
    const cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ')
    if (cookie) h.cookie = cookie
    if (this.csrf) h['x-csrf-token'] = this.csrf
    let payload: any = body
    if (body !== undefined && !(body instanceof Uint8Array)) {
      payload = JSON.stringify(body)
      h['content-type'] = 'application/json'
    }
    const res: Response = await app.handle(new Request('http://localhost' + path, { method, headers: h, body: payload }))
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(';')
      const at = pair.indexOf('=')
      this.jar.set(pair.slice(0, at), pair.slice(at + 1))
    }
    return res
  }
  async json(method: string, path: string, body?: any, headers: Record<string, string> = {}) {
    const res = await this.raw(method, path, body, headers)
    return { status: res.status, data: (await res.json().catch(() => null)) as any, res }
  }
  async login(username: string, password: string) {
    this.csrf = (await this.json('GET', '/api/session')).data.csrf
    const r = await this.json('POST', '/api/login', { username, password })
    expect(r.status).toBe(200)
    this.csrf = r.data.csrf
    return this
  }
}

const PW = 'harbor-lamp-42'
const admin = new Client()
const home = (...p: string[]) => join(process.env.STORAGE_DIR!, 'users', 'vo-owner', ...p)
const code = (r: { status: number; data: any }) => ({ status: r.status, code: r.data?.code })
const PDF = new TextEncoder().encode('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n')

let owner: Client

async function make(body: Record<string, unknown> = {}) {
  return owner.json('POST', '/api/shares', { space: 'home', path: '/pack', days: 7, ...body })
}
async function token(body: Record<string, unknown> = {}) {
  const r = await make(body)
  expect(r.status).toBe(200)
  return r.data.token as string
}
const q = (p: string) => `?path=${encodeURIComponent(p)}`

beforeAll(async () => {
  ;({ app } = await import('../src/index'))
  ;({ settings } = await import('../src/settings'))
  sharesMod = await import('../src/shares')
  await admin.login('admin', process.env.ADMIN_PASSWORD!)
  const r = await admin.json('POST', '/api/admin/users', {
    username: 'vo-owner', name: 'vo-owner', password: PW, role: 'user', permissions: ['read', 'write', 'upload', 'download', 'share'], publicPermissions: [],
  })
  expect(r.status).toBe(200)
  mkdirSync(home('pack', 'sub'), { recursive: true })
  writeFileSync(home('pack', 'doc.pdf'), PDF)
  writeFileSync(home('pack', 'note.txt'), 'hello text')
  writeFileSync(home('pack', 'data.json'), '{"a":1}')
  writeFileSync(home('pack', 'pic.png'), Buffer.from('89504e470d0a1a0a', 'hex'))
  writeFileSync(home('pack', 'tool.exe'), 'MZ')
  writeFileSync(home('pack', 'big.log'), 'x'.repeat(1024 * 1024 + 10))
  writeFileSync(home('pack', 'sub', 'inner.txt'), 'inner')
  writeFileSync(home('pack', 'bundle.zip'), zipSync({ 'a.txt': new TextEncoder().encode('inside') }))
  writeFileSync(home('single.pdf'), PDF)
  owner = await new Client().login('vo-owner', PW)
})

afterEach(() => {
  settings.update({ share: undefined })
})

describe('making a view-only link', () => {
  test('a download link can be view only; it is shown as such and keeps no download count limit', async () => {
    const r = await make({ viewOnly: true, maxDownloads: 5 })
    expect(r.status).toBe(200)
    expect(r.data.share).toMatchObject({ kind: 'download', viewOnly: true, watermark: false, maxDownloads: null })
    expect((await owner.json('GET', '/api/shares')).data.shares.find((s: any) => s.id === r.data.share.id).viewOnly).toBe(true)
  })

  test('an ordinary link is not view only', async () => {
    const r = await make()
    expect(r.data.share).toMatchObject({ viewOnly: false, watermark: false })
  })

  test('an upload link can not be view only', async () => {
    const r = await make({ kind: 'upload', viewOnly: true })
    expect(code(r)).toEqual({ status: 400, code: 'share.view-only-download-only' })
  })

  test('the watermark needs view only, has a custom text, and the text is bounded', async () => {
    expect((await make({ watermark: true })).data.share.watermark).toBe(false)
    const r = await make({ viewOnly: true, watermark: true, watermarkText: '  For ACME only \u0007 ' })
    expect(r.data.share).toMatchObject({ viewOnly: true, watermark: true })
    expect(r.data.share.watermarkText).not.toMatch(/[\u0000-\u001f]/)
    expect(code(await make({ viewOnly: true, watermark: true, watermarkText: 'x'.repeat(101) }))).toEqual({ status: 400, code: 'share.watermark-too-long' })
  })
})

describe('admin policy', () => {
  test('forbid: no view-only links', async () => {
    settings.update({ share: { viewOnly: 'forbid' } })
    expect(code(await make({ viewOnly: true }))).toEqual({ status: 400, code: 'share.view-only-forbidden' })
    expect((await make()).status).toBe(200)
  })

  test('force: every new download link is view only; upload links are not touched', async () => {
    settings.update({ share: { viewOnly: 'force' } })
    expect((await make()).data.share.viewOnly).toBe(true)
    const up = await make({ kind: 'upload' })
    expect(up.status).toBe(200)
    expect(up.data.share.viewOnly).toBe(false)
  })

  test('forceWatermark puts the watermark on every view-only link', async () => {
    settings.update({ share: { forceWatermark: true } })
    expect((await make({ viewOnly: true })).data.share.watermark).toBe(true)
    expect((await make()).data.share.watermark).toBe(false)
  })

  test('the policy is saved by an admin with the settings API and validated', async () => {
    const ok = await admin.json('PUT', '/api/admin/settings', { share: { viewOnly: 'force', forceWatermark: true }, password: process.env.ADMIN_PASSWORD })
    expect(ok.status).toBe(200)
    expect(ok.data.share.viewOnly).toEqual({ value: 'force', source: 'web' })
    expect(ok.data.share.forceWatermark.value).toBe(true)
    expect((await admin.json('PUT', '/api/admin/settings', { share: { viewOnly: 'sometimes' }, password: process.env.ADMIN_PASSWORD })).status).toBe(400)
    const reset = await admin.json('PUT', '/api/admin/settings', { share: { viewOnly: null, forceWatermark: null }, password: process.env.ADMIN_PASSWORD })
    expect(reset.data.share.viewOnly).toEqual({ value: 'allow', source: 'default' })
  })
})

describe('every download path refuses', () => {
  test('a folder link: file, sub folder, whole folder (zip) and ranges all answer 403 share.view-only', async () => {
    const t = await token({ viewOnly: true })
    const visitor = new Client()
    for (const path of ['/doc.pdf', '/note.txt', '/sub', '/sub/inner.txt', '/nope']) {
      const r = await visitor.json('GET', `/api/s/${t}/download${q(path)}`)
      expect(code(r)).toEqual({ status: 403, code: 'share.view-only' })
    }
    expect(code(await visitor.json('GET', `/api/s/${t}/download`))).toEqual({ status: 403, code: 'share.view-only' })
    for (const range of ['bytes=0-3', 'bytes=-5', 'bytes=0-']) {
      const r = await visitor.raw('GET', `/api/s/${t}/download${q('/doc.pdf')}`, undefined, { range })
      expect(r.status).toBe(403)
    }
    expect((await visitor.raw('HEAD', `/api/s/${t}/download${q('/doc.pdf')}`)).status).toBeGreaterThanOrEqual(400)
  })

  test('a single-file link too', async () => {
    const t = await token({ viewOnly: true, path: '/single.pdf' })
    expect(code(await new Client().json('GET', `/api/s/${t}/download`))).toEqual({ status: 403, code: 'share.view-only' })
  })

  test('a file taken out of a zip is a download as well; listing the zip is a preview and still works', async () => {
    const t = await token({ viewOnly: true })
    const visitor = new Client()
    const entry = encodeURIComponent('a.txt')
    expect(code(await visitor.json('GET', `/api/s/${t}/archive/file${q('/bundle.zip')}&entry=${entry}`))).toEqual({ status: 403, code: 'share.view-only' })
    const list = await visitor.json('GET', `/api/s/${t}/archive/list${q('/bundle.zip')}`)
    expect(list.status).toBe(200)
  })

  test('a link that is not view only still downloads (nothing changed for it)', async () => {
    const t = await token()
    const r = await new Client().raw('GET', `/api/s/${t}/download${q('/note.txt')}`)
    expect(r.status).toBe(200)
    expect(await r.text()).toBe('hello text')
    expect((await new Client().raw('GET', `/api/s/${t}/view${q('/note.txt')}`)).status).toBe(404)
  })

  test('a view-only link has no way to the download counter either: nothing counts', async () => {
    const r = await make({ viewOnly: true })
    const t = r.data.token as string
    const visitor = new Client()
    await visitor.raw('GET', `/api/s/${t}/download${q('/doc.pdf')}`)
    await visitor.raw('GET', `/api/s/${t}/view${q('/doc.pdf')}`)
    expect(sharesMod.findShare(r.data.share.id)!.downloads).toBe(0)
  })

  test('a password still comes first', async () => {
    const t = await token({ viewOnly: true, password: 'secret-pw-1' })
    const visitor = new Client()
    expect(code(await visitor.json('GET', `/api/s/${t}/download${q('/doc.pdf')}`))).toEqual({ status: 401, code: 'share.password-required' })
    expect(code(await visitor.json('GET', `/api/s/${t}/view${q('/doc.pdf')}`))).toEqual({ status: 401, code: 'share.password-required' })
  })

  test('WebDAV does not reach share links', async () => {
    const t = await token({ viewOnly: true })
    for (const p of [`/dav/${t}/doc.pdf`, `/dav/shared/${t}/doc.pdf`, `/dav/s/${t}/doc.pdf`]) {
      const r = await new Client().raw('GET', p)
      expect([401, 403, 404, 405]).toContain(r.status)
    }
  })
})

describe('the preview', () => {
  test('a PDF is shown inline, with ranges (the viewer needs them)', async () => {
    const t = await token({ viewOnly: true })
    const visitor = new Client()
    const r = await visitor.raw('GET', `/api/s/${t}/view${q('/doc.pdf')}`)
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toContain('pdf')
    expect(r.headers.get('content-disposition')).toStartWith('inline')
    expect(r.headers.get('x-content-type-options')).toBe('nosniff')
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(PDF)
    expect((await visitor.raw('GET', `/api/s/${t}/view${q('/doc.pdf')}`, undefined, { range: 'bytes=0-3' })).status).toBe(206)
  })

  test('small text types are shown as plain text in a sandbox', async () => {
    const t = await token({ viewOnly: true })
    for (const [path, body] of [['/note.txt', 'hello text'], ['/data.json', '{"a":1}'], ['/sub/inner.txt', 'inner']]) {
      const r = await new Client().raw('GET', `/api/s/${t}/view${q(path)}`)
      expect(r.status).toBe(200)
      expect(r.headers.get('content-type')).toStartWith('text/plain')
      expect(r.headers.get('content-security-policy')).toContain('sandbox')
      expect(await r.text()).toBe(body)
    }
  })

  test('other kinds, pictures (they go through the downscaled thumb) and big text are not served by /view', async () => {
    const t = await token({ viewOnly: true })
    for (const path of ['/tool.exe', '/pic.png', '/bundle.zip']) {
      expect(code(await new Client().json('GET', `/api/s/${t}/view${q(path)}`))).toEqual({ status: 415, code: 'share.not-previewable' })
    }
    expect(code(await new Client().json('GET', `/api/s/${t}/view${q('/big.log')}`))).toEqual({ status: 413, code: 'share.not-previewable' })
  })

  test('/view stays inside the shared folder', async () => {
    const t = await token({ viewOnly: true })
    for (const path of ['/../single.pdf', '/sub/../../single.pdf', '/%2e%2e/single.pdf', '/nope.pdf']) {
      const r = await new Client().raw('GET', `/api/s/${t}/view${q(path)}`)
      expect(r.status).toBeGreaterThanOrEqual(400)
    }
  })

  test('a single-file link previews its one file', async () => {
    const t = await token({ viewOnly: true, path: '/single.pdf' })
    expect((await new Client().raw('GET', `/api/s/${t}/view`)).status).toBe(200)
  })

  test('a revoked or expired view-only link answers nothing', async () => {
    const r = await make({ viewOnly: true })
    const t = r.data.token as string
    expect((await owner.json('DELETE', `/api/shares/${r.data.share.id}`)).status).toBe(200)
    expect((await new Client().raw('GET', `/api/s/${t}/view${q('/doc.pdf')}`)).status).toBe(404)
  })
})

describe('the page learns it is view only and gets the watermark text', () => {
  test('the info carries viewOnly and, with a watermark, the link name, the visitor address and the time', async () => {
    const t = await token({ viewOnly: true, watermark: true })
    const info = await new Client().json('GET', `/api/s/${t}`)
    expect(info.data.viewOnly).toBe(true)
    expect(info.data.watermark).toMatch(/^pack · .+ · \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/)
    const folder = await new Client().json('GET', `/api/s/${t}${q('/sub')}`)
    expect(folder.data.watermark).toBe(info.data.watermark.replace(/\d{2}:\d{2} UTC$/, folder.data.watermark.slice(-9)))
  })

  test('a custom text replaces it; without a watermark there is none; an ordinary link is not view only', async () => {
    expect((await new Client().json('GET', `/api/s/${await token({ viewOnly: true, watermark: true, watermarkText: 'For ACME only' })}`)).data.watermark).toBe('For ACME only')
    expect((await new Client().json('GET', `/api/s/${await token({ viewOnly: true })}`)).data).toMatchObject({ viewOnly: true, watermark: null })
    // an ordinary link answers exactly as before view-only existed
    expect((await new Client().json('GET', `/api/s/${await token()}`)).data).not.toHaveProperty('viewOnly')
  })

  test('the owner can not turn a view-only link into a downloadable one afterwards (there is no such edit)', async () => {
    const r = await make({ viewOnly: true })
    const res = await owner.json('PUT', `/api/shares/${r.data.share.id}`, { viewOnly: false })
    expect([404, 405]).toContain(res.status)
    expect(sharesMod.findShare(r.data.share.id)!.viewOnly).toBe(true)
  })
})
