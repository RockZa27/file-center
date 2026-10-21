import { defineStore } from 'pinia'
import { api, hooks, setCsrf } from './api'
import { i18n } from './i18n'

const read = (k, d) => { try { return localStorage.getItem(k) ?? d } catch { return d } }
const write = (k, v) => { try { localStorage.setItem(k, v) } catch { /* private mode */ } }

export const useAppStore = defineStore('app', {
  state: () => ({
    ready: false,
    failed: false,
    user: null,
    spaces: {},
    config: { appName: 'File Center', primaryColor: '#2563eb', uploadChunkSize: 8 * 1024 * 1024, uploadMaxSize: 0, uploadSimultaneous: 3 },
    theme: read('fc.theme', 'auto'),
    lang: read('fc.lang', 'th'),
    view: ['list', 'grid', 'gallery'].includes(read('fc.view', 'list')) ? read('fc.view', 'list') : 'list',
    /** the signed-in user's starred places, as `space:path` */
    favorites: [],
    /** the group folders the signed-in user is a member of (the side menu shows them only then) */
    groups: [],
  }),
  getters: {
    /** the super admin: sees everything */
    isAdmin: s => s.user?.role === 'admin',
    isManager: s => s.user?.role === 'manager',
    /** super admin or manager: the pages under "users", "activity" and the dashboard */
    isStaff: s => s.user?.role === 'admin' || s.user?.role === 'manager',
    isGuest: s => !s.user,
    appName: s => s.config.appName,
    primaryColor: s => s.config.primaryColor,
    isFavorite: s => (space, path) => s.favorites.includes(`${space}:${path}`),
    can: s => (space, perm) => !!s.spaces[space]?.includes(perm),
    hasSpace: s => space => !!s.spaces[space],
    publicAvailable: s => !!s.spaces.public,
    // a share link needs `share` and `download` in the same space; visitors never make links
    // a folder to another user needs `share` alone, in the personal folder
    canGrant: s => !!s.user && !!s.spaces.home?.includes('share'),
    canShare: s => !!s.user && Object.values(s.spaces).some(p => p.includes('share') && (p.includes('download') || p.includes('upload'))),
  },
  actions: {
    apply(snapshot) {
      setCsrf(snapshot.csrf)
      this.user = snapshot.user
      this.spaces = snapshot.spaces
      this.config = snapshot.config
      if (!snapshot.user) { this.favorites = []; this.groups = [] }
    },
    async loadGroups() {
      if (!this.user) return
      try { this.groups = (await api.myGroups()).items } catch { /* the menu item just stays as it was */ }
    },
    async loadFavorites() {
      if (!this.user) return
      try { this.favorites = (await api.favorites()).items.map(i => `${i.space}:${i.path}`) } catch { /* the stars are a nicety */ }
    },
    /** answers whether the place is a favorite now; throws the server's error (e.g. the list is full) */
    async toggleFavorite(space, path) {
      const key = `${space}:${path}`
      if (this.favorites.includes(key)) {
        await api.removeFavorite(space, path)
        this.favorites = this.favorites.filter(k => k !== key)
        return false
      }
      await api.addFavorite(space, path)
      this.favorites = [key, ...this.favorites]
      return true
    },
    async init() {
      hooks.onUnauthorized = () => {
        if (this.user) this.refresh()
      }
      i18n.global.locale.value = this.lang
      try {
        this.apply(await api.session())
      } catch {
        this.failed = true
      } finally {
        this.ready = true
      }
    },
    async refresh() {
      this.apply(await api.session())
    },
    /** answers the ticket when a code is needed next, else null (signed in) */
    async login(username, password) {
      const r = await api.login(username, password)
      if (r.twoFactor) return r.ticket
      this.apply(r)
      return null
    },
    async login2fa(ticket, code) {
      this.apply(await api.login2fa(ticket, code))
    },
    async logout() {
      this.apply(await api.logout())
    },
    setTheme(v) { this.theme = v; write('fc.theme', v) },
    setLang(v) {
      this.lang = v
      write('fc.lang', v)
      i18n.global.locale.value = v
      // the public page's texts come from the server in the asked language: ask again so they follow at once
      this.refresh().catch(() => { /* kept as they were; the next refresh brings them */ })
    },
    setView(v) { this.view = v; write('fc.view', v) },
  },
})
