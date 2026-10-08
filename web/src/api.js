let csrf = ''
export const setCsrf = v => { csrf = v }

export class ApiError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

/** set by the store: called when the server says the session is gone */
export const hooks = { onUnauthorized: null }

async function resync() {
  const res = await fetch('/api/session', { credentials: 'same-origin' })
  if (res.ok) setCsrf((await res.json()).csrf)
}

async function call(method, url, body, extraHeaders = {}, retried = false) {
  const headers = { 'x-csrf-token': csrf, ...extraHeaders }
  let payload
  if (body !== undefined) {
    if (body instanceof Blob || body instanceof ArrayBuffer) payload = body
    else { payload = JSON.stringify(body); headers['content-type'] = 'application/json' }
  }
  let res
  try {
    res = await fetch(url, { method, headers, body: payload, credentials: 'same-origin' })
  } catch {
    throw new ApiError(0, 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้')
  }
  let data = null
  try { data = await res.json() } catch { /* empty body */ }
  if (!res.ok) {
    // the server restarted or dropped the visitor's session: fetch a fresh token and try once more
    if (res.status === 403 && data?.code === 'csrf' && !retried) {
      await resync()
      return call(method, url, body, extraHeaders, true)
    }
    if (res.status === 401 && hooks.onUnauthorized) hooks.onUnauthorized()
    throw new ApiError(res.status, data?.error || `เกิดข้อผิดพลาด (${res.status})`)
  }
  return data
}

const qs = o => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== '')).toString()
const get = (url, params) => call('GET', params ? `${url}?${qs(params)}` : url)
const post = (url, body = {}) => call('POST', url, body)

export const api = {
  session: () => get('/api/session'),
  login: (username, password) => post('/api/login', { username, password }),
  logout: () => post('/api/logout'),
  changePassword: (current, next) => post('/api/password', { current, next }),

  list: (space, path) => get('/api/list', { space, path }),
  folders: (space, path) => get('/api/folders', { space, path }),
  search: (space, q, path) => get('/api/search', { space, q, path }),
  mkdir: (space, path, name) => post('/api/mkdir', { space, path, name }),
  newFile: (space, path, name) => post('/api/newfile', { space, path, name }),
  getContent: (space, path) => get('/api/content', { space, path }),
  putContent: (space, path, content) => call('PUT', '/api/content', { space, path, content }),
  rename: (space, path, name) => post('/api/rename', { space, path, name }),
  copy: (space, items, dest) => post('/api/copy', { space, items, dest }),
  move: (space, items, dest) => post('/api/move', { space, items, dest }),
  remove: (space, items) => post('/api/delete', { space, items }),
  zip: (space, path, items, name) => post('/api/zip', { space, path, items, name }),
  unzip: (space, path) => post('/api/unzip', { space, path }),
  batch: (space, path, items) => post('/api/batch', { space, path, items }),

  downloadUrl: (space, path, inline = false) =>
    `/api/download?${qs({ space, path, inline: inline ? '1' : undefined })}`,
  batchUrl: token => `/api/batch/${token}`,

  uploadInit: (space, path, name, size, relativeDir) => post('/api/upload', { space, path, name, size, relativeDir }),
  uploadComplete: id => post(`/api/upload/${id}/complete`),
  uploadCancel: id => call('DELETE', `/api/upload/${id}`),

  users: () => get('/api/admin/users'),
  createUser: u => post('/api/admin/users', u),
  updateUser: (username, u) => call('PUT', `/api/admin/users/${encodeURIComponent(username)}`, u),
  deleteUser: username => call('DELETE', `/api/admin/users/${encodeURIComponent(username)}`),
  adminFolders: path => get('/api/admin/folders', { path }),
  status: () => get('/api/admin/status'),
  activity: params => get('/api/admin/activity', params),
  trash: () => get('/api/admin/trash'),
  restore: id => post('/api/admin/trash/restore', { id }),
  purge: id => post('/api/admin/trash/purge', id ? { id } : {}),
  settings: () => get('/api/admin/settings'),
  saveSettings: s => call('PUT', '/api/admin/settings', s),
  uploadLogo: file => call('PUT', '/api/admin/logo', file, { 'content-type': file.type }),
  removeLogo: () => call('DELETE', '/api/admin/logo'),
}

/** PUT one chunk with progress; resolves when the server has stored it */
export function putChunk(id, index, blob, onProgress, registerAbort) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', `/api/upload/${id}/${index}`)
    xhr.setRequestHeader('x-csrf-token', csrf)
    xhr.setRequestHeader('content-type', 'application/octet-stream')
    xhr.upload.onprogress = e => e.lengthComputable && onProgress(e.loaded)
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve()
      let msg = `อัปโหลดไม่สำเร็จ (${xhr.status})`
      try { msg = JSON.parse(xhr.responseText).error || msg } catch { /* keep default */ }
      const err = new ApiError(xhr.status, msg)
      if (xhr.status === 401 && hooks.onUnauthorized) hooks.onUnauthorized()
      reject(err)
    }
    xhr.onerror = () => reject(new ApiError(0, 'การเชื่อมต่อขัดข้อง'))
    xhr.onabort = () => reject(new ApiError(-1, 'ยกเลิกแล้ว'))
    registerAbort(() => xhr.abort())
    xhr.send(blob)
  })
}
