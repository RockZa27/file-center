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
  // a visitor of an upload link sends no CSRF token (the server takes none there)
  if (extraHeaders['x-csrf-token'] === null) delete headers['x-csrf-token']
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
  /** filters: { type, ext, from, to, minSize, maxSize, sort, order } as the server reads them (ext comma separated) */
  search: (space, q, path, filters = {}) => get('/api/search', { space, q, path, ...filters }),
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
  /** `destSpace` (another space than `space`): copy or move between spaces, needs write and upload there */
  copy: (space, items, dest, destSpace) => post('/api/copy', { space, items, dest, destSpace }),
  move: (space, items, dest, destSpace) => post('/api/move', { space, items, dest, destSpace }),
  /** `withTrash`: the answer also holds `trashed: [{ path, id }]`, the trash entry of each item, for "undo" */
  remove: (space, items, withTrash) => post('/api/delete', { space, items, withTrash }),
  zip: (space, path, items, name) => post('/api/zip', { space, path, items, name }),
  unzip: (space, path) => post('/api/unzip', { space, path }),
  batch: (space, path, items) => post('/api/batch', { space, path, items }),

  /** { current: { size, mtime }, items: [{ id, size, mtime, savedAt, savedBy, reason }] }, newest first */
  versions: (space, path) => get('/api/versions', { space, path }),
  versionUrl: (space, path, id) => `/api/versions/${encodeURIComponent(id)}/download?${qs({ space, path })}`,
  /** `expectedMtime` (current.mtime of the list): 409 files.changed-elsewhere when the file changed since */
  restoreVersion: (space, path, id, expectedMtime) => post(`/api/versions/${encodeURIComponent(id)}/restore`, { space, path, expectedMtime }),
  deleteVersion: (space, path, id) => call('DELETE', `/api/versions/${encodeURIComponent(id)}?${qs({ space, path })}`),
  favorites: () => get('/api/me/favorites'),
  addFavorite: (space, path) => post('/api/me/favorites', { space, path }),
  removeFavorite: (space, path) => call('DELETE', '/api/me/favorites', { space, path }),
  recent: () => get('/api/me/recent'),

  downloadUrl: (space, path, inline = false) =>
    `/api/download?${qs({ space, path, inline: inline ? '1' : undefined })}`,
  batchUrl: token => `/api/batch/${token}`,

  /** { image, pdf, video }: which kinds the server can make a small picture of (signed-in users only) */
  thumbStatus: () => get('/api/thumbs/status'),
  /** `version` (the file's mtime) only makes a changed file a new address: the browser keeps a picture for a day */
  thumbUrl: (space, path, size = 256, version) => `/api/thumb?${qs({ space, path, size, v: version })}`,
  shareThumbUrl: (token, path, size = 256, version) => `/api/s/${encodeURIComponent(token)}/thumb?${qs({ path: path && path !== '/' ? path : undefined, size, v: version })}`,

  /** the entries of a .zip without unpacking it: { entries: [{ name, dir, size, compressed, modified, encrypted }], truncated } */
  archiveList: (space, path) => get('/api/archive/list', { space, path }),
  archiveFileUrl: (space, path, entry, inline = false) => `/api/archive/file?${qs({ space, path, entry, inline: inline ? '1' : undefined })}`,
  shareArchiveList: (token, path) => get(`/api/s/${encodeURIComponent(token)}/archive/list`, path && path !== '/' ? { path } : undefined),
  shareArchiveFileUrl: (token, path, entry) => `/api/s/${encodeURIComponent(token)}/archive/file?${qs({ path: path && path !== '/' ? path : undefined, entry })}`,

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
  /** a user's own trash: { items: [{ id, name, type, size, deletedAt, deletedBy, owner, space, path, restorable }], retentionDays } */
  myTrash: () => get('/api/me/trash'),
  /** -> { ok, restoredTo, space, path } */
  restoreMine: id => post(`/api/me/trash/${encodeURIComponent(id)}/restore`),
  purgeMine: id => call('DELETE', `/api/me/trash/${encodeURIComponent(id)}`),
  emptyMine: () => call('DELETE', '/api/me/trash'),

  /** at least two letters: { users: [{ username, name }] }, ten at most */
  lookupUsers: q => get('/api/users/lookup', { q }),
  /** a folder of the caller's home to another user: perms 'view' | 'edit' -> { ok, created, grant } */
  createGrant: (path, to, perms) => post('/api/grants', { space: 'home', path, to, perms }),
  /** the same to a group the caller belongs to (an admin: any group) */
  createGroupGrant: (path, toGroup, perms) => post('/api/grants', { space: 'home', path, toGroup, perms }),
  /** { items: [{ id, path, name, to, toName, perms, createdAt, active }] }; a grant to a group has to/toName null and toGroup, toGroupName */
  myGrants: () => get('/api/grants/mine'),
  /** { items: [{ id, space: 'grant:<id>', name, owner, ownerName, perms, createdAt }] } */
  grantsToMe: () => get('/api/grants/to-me'),
  updateGrant: (id, perms) => call('PATCH', `/api/grants/${encodeURIComponent(id)}`, { perms }),
  /** the owner takes the share back; the person it was shared with leaves */
  deleteGrant: id => call('DELETE', `/api/grants/${encodeURIComponent(id)}`),

  /** { items: [{ id, name, perms: 'view' | 'edit', space, quotaBytes, used }] }: the groups the caller is in */
  myGroups: () => get('/api/groups/mine'),
  /** { groups: [{ id, name }] } for the share dialog */
  lookupGroups: q => get('/api/groups/lookup', { q }),
  /** { items: [{ id, name, space, quotaBytes, used, createdAt, createdBy, members: [{ username, name, perms }] }] } */
  adminGroups: () => get('/api/admin/groups'),
  createGroup: body => post('/api/admin/groups', body),
  updateGroup: (id, body) => call('PATCH', `/api/admin/groups/${encodeURIComponent(id)}`, body),
  deleteGroup: (id, password) => call('DELETE', `/api/admin/groups/${encodeURIComponent(id)}`, { password }),
  /** adds the member, or changes the rights of one who is in already -> { ok, added, member } */
  setGroupMember: (id, username, perms) => call('PUT', `/api/admin/groups/${encodeURIComponent(id)}/members`, { username, perms }),
  removeGroupMember: (id, username) => call('DELETE', `/api/admin/groups/${encodeURIComponent(id)}/members/${encodeURIComponent(username)}`),

  /** WebDAV app passwords of the signed-in user: { items: [{ id, name, scope, hint, createdAt, lastUsedAt, lastIp }], max, enabled } */
  appPasswords: () => get('/api/me/app-passwords'),
  /** -> the item plus `secret`, told this once only */
  createAppPassword: (name, scope, password) => post('/api/me/app-passwords', { name, scope, password }),
  deleteAppPassword: id => call('DELETE', `/api/me/app-passwords/${encodeURIComponent(id)}`),

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
  updateFetchAndApply: (password, opts = {}) => post('/api/admin/update/fetch-and-apply', { password, ...opts }),
  /** the beta channel: the same, but only after the admin accepted the risk */
  updateFetchBeta: password => post('/api/admin/update/fetch-and-apply', { password, channel: 'beta', acceptBetaRisk: true }),

  /** { enabled, kind, host, lastSent: { <kind>: ISO time } }: never the webhook URL itself */
  alerts: () => get('/api/admin/alerts'),
  alertTest: () => post('/api/admin/alerts/test'),

  backups: () => get('/api/admin/backups'),
  backupNow: () => post('/api/admin/backups'),
  backupDelete: name => call('DELETE', `/api/admin/backups/${encodeURIComponent(name)}`),
  backupRestore: (name, password) => post('/api/admin/backups/restore', { name, password }),
  backupUrl: name => `/api/admin/backups/${encodeURIComponent(name)}/download`,
  backupEstimate: () => get('/api/admin/backups/estimate'),
  /** body: any of compression, schedule, keep, includeFiles (null = back to the default) and password; answers the new settings */
  backupSettings: body => call('PUT', '/api/admin/backups/settings', body),

  // the bell, e-mail and LINE of the signed-in user
  notifications: unreadOnly => get('/api/me/notifications', unreadOnly ? { unreadOnly: 'true' } : undefined),
  notificationsRead: ids => post('/api/me/notifications/read', ids ? { ids } : {}),
  notificationDelete: id => call('DELETE', `/api/me/notifications/${encodeURIComponent(id)}`),
  notifyPrefs: () => get('/api/me/notify-prefs'),
  saveNotifyPrefs: body => call('PUT', '/api/me/notify-prefs', body),
  setEmail: address => call('PUT', '/api/me/email', { address }),
  removeEmail: () => call('DELETE', '/api/me/email'),
  lineLink: () => post('/api/me/line/link'),
  lineUnlink: () => call('DELETE', '/api/me/line'),

  /** { space, path, days, password?, maxDownloads? } -> { share, token, url }: the token is told this once only */
  createShare: body => post('/api/shares', body),
  myShares: () => get('/api/shares'),
  allShares: () => get('/api/admin/shares'),
  revokeShare: id => call('DELETE', `/api/shares/${encodeURIComponent(id)}`),
  shareLink: id => get(`/api/shares/${encodeURIComponent(id)}/link`),
  // whoever holds the link, no account needed
  shareInfo: (token, path) => get(`/api/s/${encodeURIComponent(token)}`, path && path !== '/' ? { path } : undefined),
  shareUnlock: (token, password) => post(`/api/s/${encodeURIComponent(token)}/unlock`, { password }),
  // upload-request links: the visitor cookie is set by the server, no CSRF header is sent
  shareUploadInit: (token, name, size) => call('POST', `/api/s/${encodeURIComponent(token)}/upload`, { name, size }, { 'x-csrf-token': null }),
  shareUploadComplete: (token, id) => call('POST', `/api/s/${encodeURIComponent(token)}/upload/${id}/complete`, {}, { 'x-csrf-token': null }),
  shareUploadCancel: (token, id) => call('DELETE', `/api/s/${encodeURIComponent(token)}/upload/${id}`, undefined, { 'x-csrf-token': null }),
  shareUploadChunkUrl: (token, id) => `/api/s/${encodeURIComponent(token)}/upload/${id}`,
  shareDownloadUrl: (token, path) => `/api/s/${encodeURIComponent(token)}/download${path && path !== '/' ? `?${qs({ path })}` : ''}`,
}

/** PUT one chunk with progress; resolves when the server has stored it */
export function putChunk(id, index, blob, onProgress, registerAbort, base = '/api/upload') {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    const visitor = base !== '/api/upload'
    xhr.open('PUT', `${base}${visitor ? '' : `/${id}`}/${index}`)
    if (!visitor) xhr.setRequestHeader('x-csrf-token', csrf)
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
