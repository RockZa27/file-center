import { i18n } from './i18n'

let csrf = ''
export const setCsrf = v => { csrf = v }

const t = (key, params) => i18n.global.t(key, params)
/** the server writes its texts in the language the page shows, not the browser's */
const lang = () => i18n.global.locale.value

/** `code` and `params` come from the server's answer ({ error, code, params }) so a page can tell cases apart */
export class ApiError extends Error {
  constructor(status, message, code = '', params = {}) {
    super(message)
    this.status = status
    this.code = code || ''
    this.params = params || {}
  }
}

/** set by the store: called when the server says the session is gone */
export const hooks = { onUnauthorized: null }

async function resync() {
  const res = await fetch('/api/session', { headers: { 'x-lang': lang() }, credentials: 'same-origin' })
  if (res.ok) setCsrf((await res.json()).csrf)
}

async function call(method, url, body, extraHeaders = {}, retried = false) {
  const headers = { 'x-csrf-token': csrf, 'x-lang': lang(), ...extraHeaders }
  let payload
  if (body !== undefined) {
    if (body instanceof Blob || body instanceof ArrayBuffer) payload = body
    else { payload = JSON.stringify(body); headers['content-type'] = 'application/json' }
  }
  let res
  try {
    res = await fetch(url, { method, headers, body: payload, credentials: 'same-origin' })
  } catch {
    throw new ApiError(0, t('api.noConnection'))
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
    throw new ApiError(res.status, data?.error || t('api.failed', { status: res.status }), data?.code, data?.params)
  }
  return data
}

const qs = o => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== '')).toString()
const get = (url, params) => call('GET', params ? `${url}?${qs(params)}` : url)
const post = (url, body = {}) => call('POST', url, body)

export const api = {
  session: () => get('/api/session'),
  login: (username, password) => post('/api/login', { username, password }),
  /** answers a session snapshot, or { twoFactor: true, ticket } when the account needs a code too */
  login2fa: (ticket, code) => post('/api/login/2fa', { ticket, code }),
  logout: () => post('/api/logout'),
  sessions: () => get('/api/sessions'),
  /** the current device's id gives the logout flow back: a session snapshot */
  revokeSession: id => call('DELETE', `/api/sessions/${encodeURIComponent(id)}`),
  revokeOthers: () => post('/api/sessions/revoke-others'),
  usage: () => get('/api/me/usage'),
  twoFactorSetup: password => post('/api/2fa/setup', { password }),
  twoFactorEnable: code => post('/api/2fa/enable', { code }),
  twoFactorDisable: (password, code) => post('/api/2fa/disable', { password, code }),
  twoFactorBackupCodes: (password, code) => post('/api/2fa/backup-codes', { password, code }),
  changePassword: (current, next) => post('/api/password', { current, next }),

  list: (space, path) => get('/api/list', { space, path }),
  folders: (space, path) => get('/api/folders', { space, path }),
  search: (space, q, path) => get('/api/search', { space, q, path }),
  mkdir: (space, path, name) => post('/api/mkdir', { space, path, name }),
  newFile: (space, path, name) => post('/api/newfile', { space, path, name }),
  getContent: (space, path) => get('/api/content', { space, path }),
  /** `expectedMtime` (the mtime getContent gave): the server answers 409 files.changed-elsewhere if someone saved since */
  putContent: (space, path, content, expectedMtime) => call('PUT', '/api/content', { space, path, content, expectedMtime }),
  /** the whole file as bytes, for the viewers that draw Office files in the page */
  fileBytes: async (space, path) => {
    let res
    try {
      res = await fetch(api.downloadUrl(space, path, true), { headers: { 'x-lang': lang() }, credentials: 'same-origin' })
    } catch {
      throw new ApiError(0, t('api.noConnection'))
    }
    if (!res.ok) {
      let data = null
      try { data = await res.json() } catch { /* not JSON */ }
      if (res.status === 401 && hooks.onUnauthorized) hooks.onUnauthorized()
      throw new ApiError(res.status, data?.error || t('api.failed', { status: res.status }), data?.code, data?.params)
    }
    return new Uint8Array(await res.arrayBuffer())
  },
  /** ONLYOFFICE: { apiUrl, config } for one file, mode 'edit' or 'view' */
  officeConfig: (space, path, mode) => post('/api/office/config', { space, path, mode }),
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
  userSessions: username => get(`/api/admin/users/${encodeURIComponent(username)}/sessions`),
  revokeUserSessions: username => post(`/api/admin/users/${encodeURIComponent(username)}/sessions/revoke`),
  resetTwoFactor: (username, password) => post(`/api/admin/users/${encodeURIComponent(username)}/2fa/reset`, { password }),
  adminFolders: path => get('/api/admin/folders', { path }),
  status: () => get('/api/admin/status'),
  activity: params => get('/api/admin/activity', params),
  /** the CSV of the activity log with the same filters as the page ({ user, action, q }) */
  activityExportUrl: params => `/api/admin/activity/export?${qs({ format: 'csv', ...params })}`,
  logs: params => get('/api/admin/logs', params),
  logsDownloadUrl: () => '/api/admin/logs/download',
  trash: () => get('/api/admin/trash'),
  restore: id => post('/api/admin/trash/restore', { id }),
  purge: id => post('/api/admin/trash/purge', id ? { id } : {}),
  settings: () => get('/api/admin/settings'),
  saveSettings: s => call('PUT', '/api/admin/settings', s),
  uploadLogo: file => call('PUT', '/api/admin/logo', file, { 'content-type': file.type }),
  removeLogo: () => call('DELETE', '/api/admin/logo'),

  updateStatus: () => get('/api/admin/update'),
  updateInit: size => post('/api/admin/update/upload', { size }),
  updateStage: id => post('/api/admin/update/stage', { id }),
  updateDiscard: id => call('DELETE', `/api/admin/update/staged/${id}`),
  updateApply: (id, password) => post('/api/admin/update/apply', { id, password }),
  updateRollback: (dir, password) => post('/api/admin/update/rollback', { dir, password }),
  /** is there a newer version at UPDATE_SOURCE ({ current, latest, newer }) */
  updateCheck: () => get('/api/admin/update/check'),
  /** check, download, verify and install the newest version in one go; a failure names its step in params.step */
  updateFetchAndApply: password => post('/api/admin/update/fetch-and-apply', { password }),

  /** { enabled, kind, host, lastSent: { <kind>: ISO time } }: never the webhook URL itself */
  alerts: () => get('/api/admin/alerts'),
  alertTest: () => post('/api/admin/alerts/test'),

  backups: () => get('/api/admin/backups'),
  backupNow: () => post('/api/admin/backups'),
  backupDelete: name => call('DELETE', `/api/admin/backups/${encodeURIComponent(name)}`),
  backupRestore: (name, password) => post('/api/admin/backups/restore', { name, password }),
  backupUrl: name => `/api/admin/backups/${encodeURIComponent(name)}/download`,

  /** { space, path, days, password?, maxDownloads? } -> { share, token, url }: the token is told this once only */
  createShare: body => post('/api/shares', body),
  myShares: () => get('/api/shares'),
  allShares: () => get('/api/admin/shares'),
  revokeShare: id => call('DELETE', `/api/shares/${encodeURIComponent(id)}`),
  // whoever holds the link, no account needed
  shareInfo: (token, path) => get(`/api/s/${encodeURIComponent(token)}`, path && path !== '/' ? { path } : undefined),
  shareUnlock: (token, password) => post(`/api/s/${encodeURIComponent(token)}/unlock`, { password }),
  shareDownloadUrl: (token, path) => `/api/s/${encodeURIComponent(token)}/download${path && path !== '/' ? `?${qs({ path })}` : ''}`,
}

/** PUT one chunk with progress; resolves when the server has stored it */
export function putChunk(id, index, blob, onProgress, registerAbort) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', `/api/upload/${id}/${index}`)
    xhr.setRequestHeader('x-csrf-token', csrf)
    xhr.setRequestHeader('x-lang', lang())
    xhr.setRequestHeader('content-type', 'application/octet-stream')
    xhr.upload.onprogress = e => e.lengthComputable && onProgress(e.loaded)
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve()
      let data = null
      try { data = JSON.parse(xhr.responseText) } catch { /* not JSON: the default text below */ }
      const err = new ApiError(xhr.status, data?.error || t('api.uploadFailed', { status: xhr.status }), data?.code, data?.params)
      if (xhr.status === 401 && hooks.onUnauthorized) hooks.onUnauthorized()
      reject(err)
    }
    xhr.onerror = () => reject(new ApiError(0, t('api.connectionLost')))
    xhr.onabort = () => reject(new ApiError(-1, t('api.canceled')))
    registerAbort(() => xhr.abort())
    xhr.send(blob)
  })
}

/**
 * Saves a file the server sends (log, CSV, backup) as a real browser download: the browser streams it to disk,
 * nothing is held in memory here. A plain link saves the server's JSON error as the file once the session has
 * expired, so ask who is signed in first; signed out, the app goes to the sign-in page the usual way and the
 * caller shows the error. `admin` downloads also need an administrator.
 */
export async function download(url, { name = '', admin = false } = {}) {
  const s = await call('GET', '/api/session')
  if (s?.csrf) setCsrf(s.csrf)
  if (!s?.user) {
    if (hooks.onUnauthorized) hooks.onUnauthorized()
    throw new ApiError(401, t('api.signedOut'), 'auth.required')
  }
  if (s.user.mustChangePassword) throw new ApiError(403, t('api.mustChangePassword'), 'must-change-password')
  if (admin && s.user.role !== 'admin') throw new ApiError(403, t('api.forbidden'), 'auth.forbidden')
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  a.remove()
}
