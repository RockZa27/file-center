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
    view: read('fc.view', 'list'),
  }),
  getters: {
    isAdmin: s => s.user?.role === 'admin',
    isGuest: s => !s.user,
    appName: s => s.config.appName,
    primaryColor: s => s.config.primaryColor,
    can: s => (space, perm) => !!s.spaces[space]?.includes(perm),
    hasSpace: s => space => !!s.spaces[space],
    publicAvailable: s => !!s.spaces.public,
  },
  actions: {
    apply(snapshot) {
      setCsrf(snapshot.csrf)
      this.user = snapshot.user
      this.spaces = snapshot.spaces
      this.config = snapshot.config
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
    async login(username, password) {
      this.apply(await api.login(username, password))
    },
    async logout() {
      this.apply(await api.logout())
    },
    setTheme(v) { this.theme = v; write('fc.theme', v) },
    setLang(v) { this.lang = v; write('fc.lang', v); i18n.global.locale.value = v },
    setView(v) { this.view = v; write('fc.view', v) },
  },
})
