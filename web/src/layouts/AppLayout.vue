<template>
  <div class="shell">
    <aside class="sidebar" :class="{ open: drawer }">
      <div class="brand"><app-logo :to="{ name: 'files' }" /></div>
      <nav class="nav">
        <section v-for="sec in sections" :key="sec.key" class="nav-sec" :data-tour="'nav-section-' + sec.key">
          <div class="nav-head">{{ sec.label }}</div>
          <router-link
            v-for="item in sec.items" :key="item.name" :to="{ name: item.name }" class="nav-item" :class="{ 'router-link-active': item.active }"
            :data-tour="'nav-' + item.name" @click="drawer = false"
          >
            <n-icon :component="item.icon" size="19" />
            <span class="nav-label">{{ item.label }}</span>
            <n-badge v-if="item.badge" :value="item.badge" :type="item.badgeType" class="badge" />
            <n-badge v-else-if="item.dot" dot type="info" class="badge" />
          </router-link>
        </section>
      </nav>
    </aside>
    <div v-if="drawer" class="scrim" @click="drawer = false" />

    <div class="main">
      <header class="topbar">
        <n-button class="menu-btn" quaternary circle data-tour="menu-toggle" :aria-label="t('nav.menu')" @click="drawer = true">
          <template #icon><n-icon :component="MenuOutline" /></template>
        </n-button>
        <nav class="crumbs" :aria-label="t('ux.here')">
          <template v-for="(c, i) in crumbs" :key="i">
            <span v-if="i" class="sep" aria-hidden="true">›</span>
            <span class="crumb" :class="{ last: i === crumbs.length - 1 }" :aria-current="i === crumbs.length - 1 ? 'page' : undefined">{{ c }}</span>
          </template>
        </nav>
        <div class="right">
          <span class="bell-wrap" data-tour="bell"><notification-bell v-if="!app.user?.mustSetup2fa" @settings="openProfile('notify')" /></span>
          <n-dropdown trigger="click" placement="bottom-end" :options="helpOptions" @select="onHelp">
            <n-button class="help-btn" quaternary circle data-tour="help-button" :title="t('nav.helpTip')" :aria-label="t('nav.helpTip')">
              <template #icon><n-icon :component="HelpCircleOutline" /></template>
            </n-button>
          </n-dropdown>
          <n-dropdown trigger="click" :options="userOptions" @select="onSelect">
            <button type="button" class="user-btn" data-tour="user-menu">
              <n-avatar round size="small" class="avatar">{{ initial }}</n-avatar>
              <span class="user-name">{{ app.user?.name }}</span>
            </button>
          </n-dropdown>
        </div>
      </header>
      <!-- nothing behind the forced 2FA dialog: the server refuses every page call until it is on -->
      <main><router-view v-if="!app.user?.mustSetup2fa" :key="viewKey" /></main>
    </div>
    <profile-modal v-model:show="profileOpen" :open-tab="profileTab" />
    <whats-new-modal />
    <spotlight-tour />
  </div>
</template>

<script setup>
import { computed, h, onBeforeUnmount, provide, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { NAvatar, NBadge, NButton, NDropdown, NIcon } from 'naive-ui'
import {
  ContrastOutline, FolderOpenOutline, FolderOutline, GlobeOutline, BookOutline, HelpCircleOutline, PlayCircleOutline, SparklesOutline, KeyOutline, LanguageOutline, LinkOutline, LogOutOutline, MenuOutline, MoonOutline, PeopleCircleOutline, PersonOutline,
  ServerOutline, ShareSocialOutline, SpeedometerOutline, StarOutline, SunnyOutline, TimeOutline, TrashOutline,
} from '@vicons/ionicons5'
import { api } from '../api'
import AppLogo from '../components/AppLogo.vue'
import NotificationBell from '../components/NotificationBell.vue'
import ProfileModal from '../components/ProfileModal.vue'
import SpotlightTour from '../components/SpotlightTour.vue'
import WhatsNewModal from '../components/WhatsNewModal.vue'
import { releasesFor } from '../guide/releases'
import { drawerHook, guide, loadGuide, openWhatsNew, resetGuide, saveSeen, startFullTour, startTour, tour } from '../guide/tour'
import { pageTourSteps } from '../guide/tours'
import { compareVersions } from '../guide/util'
import { useAppStore } from '../store'
import { useFeedback, useRoleLabel } from '../composables'

const { t } = useI18n()
const fb = useFeedback()
const roleLabel = useRoleLabel()
const app = useAppStore()
const route = useRoute()
const router = useRouter()

const drawer = ref(false)
const profileOpen = ref(false)
const profileTab = ref('password')
function openProfile(tab = 'password') { profileTab.value = tab; profileOpen.value = true }
// the tour opens and closes the side menu drawer (a phone shows the menu as a drawer)
drawerHook.open = () => { drawer.value = true }
drawerHook.close = () => { drawer.value = false }
drawerHook.isOpen = () => drawer.value
const warnings = ref([])
let timer = null

// the Update tab of the system page shows a dot when the status says a newer version exists
const updateAvailable = computed(() => warnings.value.some(w => w.code === 'update.available'))
provide('updateAvailable', updateAvailable)
const alertCount = computed(() => warnings.value.filter(w => w.level !== 'info').length)
const critical = computed(() => warnings.value.some(w => w.level === 'critical'))

// the same items and the same rules as before, only grouped; a group with no item is not shown
const sections = computed(() => {
  const files = [{ name: 'files', label: t('nav.files'), icon: FolderOutline }]
  files.push({ name: 'favorites', label: t('nav.favorites'), icon: StarOutline })
  if (app.groups.length) files.push({ name: 'groups', label: t('nav.groupFolders'), icon: FolderOpenOutline })
  files.push({ name: 'my-trash', label: app.isAdmin ? t('nav.myTrash') : t('nav.trash'), icon: TrashOutline })

  const sharing = [{ name: 'with-me', label: t('nav.withMe'), icon: ShareSocialOutline }]
  if (app.canShare || app.canGrant || app.isStaff) sharing.push({ name: 'links', label: t('nav.shareLinks'), icon: LinkOutline })
  if (!app.isAdmin && app.hasSpace('public')) sharing.push({ name: 'shared', label: t('nav.publicFolder'), icon: GlobeOutline })
  else if (app.isAdmin && app.config.publicEnabled) sharing.push({ name: 'shared', label: t('nav.publicPage'), icon: GlobeOutline })

  const manage = []
  if (app.isStaff) {
    manage.push(
      { name: 'dashboard', label: t('nav.dashboard'), icon: SpeedometerOutline, badge: alertCount.value, badgeType: critical.value ? 'error' : 'warning' },
      { name: 'users', label: t('nav.users'), icon: PersonOutline },
      { name: 'admin-groups', label: t('nav.groupsAdmin'), icon: PeopleCircleOutline },
      { name: 'activity', label: t('nav.activity'), icon: TimeOutline },
    )
  }
  const system = []
  if (app.isAdmin) system.push({ name: 'settings', label: t('nav.system'), icon: ServerOutline, active: !!route.meta.system, dot: updateAvailable.value })

  return [
    { key: 'files', label: t('nav.section.files'), items: files },
    { key: 'sharing', label: t('nav.section.sharing'), items: sharing },
    { key: 'manage', label: t('nav.section.manage'), items: manage },
    { key: 'system', label: t('nav.section.system'), items: system },
  ].filter(sec => sec.items.length)
})

// the top bar only says where you are (section > page); the page's own title is the heading of the page
const systemTabs = { settings: 'nav.settings', backup: 'nav.backup', update: 'nav.update', logs: 'nav.logs', trash: 'nav.trashAll' }
const crumbs = computed(() => {
  const name = route.name
  if (route.meta.system) return [t('nav.section.system'), t(systemTabs[name] || 'nav.system')]
  if (name === 'help') return [t('nav.help')]
  const key = name === 'user-files' ? 'users' : name
  const sec = sections.value.find(s => s.items.some(i => i.name === key))
  const item = sec?.items.find(i => i.name === key)
  return item ? [sec.label, item.label] : []
})
// "?": the tour of this page (when it has one), the guide, what is new
const pageSteps = computed(() => pageTourSteps(route.name, app.user?.role))
const helpOptions = computed(() => [
  ...(pageSteps.value.length ? [{ key: 'tour', label: t('ux.helpTour'), icon: () => h(NIcon, { component: PlayCircleOutline }) }] : []),
  { key: 'guide', label: t('nav.help'), icon: () => h(NIcon, { component: BookOutline }) },
  { key: 'news', label: t('ux.helpNews'), icon: () => h(NIcon, { component: SparklesOutline }) },
])
function onHelp(key) {
  if (key === 'tour') startTour(pageSteps.value)
  if (key === 'guide') router.push({ name: 'help' })
  if (key === 'news') openWhatsNew('all', releasesFor(app.user?.role, null, app.config.version, { webdav: !!app.config.webdav }))
}
const initial = computed(() => (app.user?.name || '?').trim().slice(0, 1).toUpperCase())

const userOptions = computed(() => [
  {
    key: 'header', type: 'render',
    render: () => h('div', { style: 'padding:8px 14px;min-width:180px' }, [
      h('div', { style: 'font-weight:600' }, app.user?.name),
      h('div', { style: 'font-size:12px;color:var(--muted)' }, `${app.user?.username}${app.isStaff ? ' · ' + roleLabel(app.user.role) : ''}`),
    ]),
  },
  { type: 'divider', key: 'd' },
  { key: 'profile', label: t('nav.account'), icon: () => h(NIcon, { component: KeyOutline }) },
  {
    key: 'theme', label: t('nav.theme'), icon: () => h(NIcon, { component: ({ light: SunnyOutline, dark: MoonOutline, auto: ContrastOutline })[app.theme] }),
    children: [
      { key: 'theme:light', label: mark(app.theme === 'light', t('nav.themeLight')) },
      { key: 'theme:dark', label: mark(app.theme === 'dark', t('nav.themeDark')) },
      { key: 'theme:auto', label: mark(app.theme === 'auto', t('nav.themeAuto')) },
    ],
  },
  {
    key: 'lang', label: t('nav.language'), icon: () => h(NIcon, { component: LanguageOutline }),
    children: [
      { key: 'lang:th', label: mark(app.lang === 'th', 'ไทย') },
      { key: 'lang:en', label: mark(app.lang === 'en', 'English') },
    ],
  },
  { key: 'guide', label: t('guide.menu'), icon: () => h(NIcon, { component: BookOutline }) },
  { type: 'divider', key: 'd2' },
  { key: 'logout', label: t('nav.logout'), icon: () => h(NIcon, { component: LogOutOutline }) },
])
const mark = (on, text) => (on ? '✓ ' : '') + text

async function onSelect(key) {
  if (key === 'profile') openProfile()
  if (key === 'guide') startFullTour()
  if (key.startsWith('theme:')) app.setTheme(key.slice(6))
  if (key.startsWith('lang:')) app.setLang(key.slice(5))
  if (key === 'logout') {
    try { await app.logout() } catch (e) { return fb.fail(e) }
    resetGuide()
    router.push({ name: app.publicAvailable ? 'public' : 'login' })
  }
}

async function loadWarnings() {
  if (!app.isStaff || app.user?.mustSetup2fa) return
  try { warnings.value = (await api.status()).warnings } catch { /* the dashboard shows errors */ }
}

// the session can end on the server (timeout, password change, restart)
async function checkSession() {
  try { await app.refresh() } catch { return }
  if (!app.user) router.replace({ name: 'login' })
  else app.loadGroups()
}
// whatever call noticed that the session is gone, leave the protected area at once
watch(() => app.user, u => { if (!u) router.replace({ name: 'login' }) })
// another user (or none) on the page: the tour state and the "what is new" decision were the last one's
watch(() => app.user?.username, () => { resetGuide(); guideChecked = false; if (app.user) bootGuide() })
// the server refuses everything until a handed-out password is changed: reload the page once it is
const viewKey = ref(0)
watch(() => app.user?.mustChangePassword, (now, before) => {
  if (before && !now) { viewKey.value++; loadWarnings() }
})
// the same for the 2FA the admin requires: the setup dialog opens (also when a call finds out first) and the page reloads once it is on
watch(() => app.user?.mustSetup2fa, (now, before) => {
  if (now) openProfile('security')
  if (before && !now) { viewKey.value++; loadWarnings(); app.loadGroups() }
})

// a new user gets the welcome (and the tour), a user who updated gets what is new; nothing while the forced password dialog is up
let guideChecked = false
function showGuide() {
  if (guideChecked || !guide.loaded || !app.user || app.user.mustChangePassword || app.user.mustSetup2fa || profileOpen.value) return
  const version = app.config.version
  if (!version) return
  guideChecked = true
  if (guide.seenVersion == null) return openWhatsNew('welcome', [])
  if (compareVersions(guide.seenVersion, version) >= 0) return
  const news = releasesFor(app.user.role, guide.seenVersion, version, { webdav: !!app.config.webdav })
  if (news.length) openWhatsNew('news', news)
  else saveSeen(version)
}
// (the server answers nothing until a handed-out password is changed, so the guide is fetched after that)
function bootGuide() {
  if (!app.user || app.user.mustChangePassword || app.user.mustSetup2fa) return
  guide.loaded = false
  loadGuide().then(showGuide).catch(() => { /* a nicety */ })
}
watch(() => app.user?.mustChangePassword, (now, before) => { if (before && !now) bootGuide() })
watch(() => app.user?.mustSetup2fa, (now, before) => { if (before && !now) bootGuide() })
watch(profileOpen, showGuide)
const onVisible = () => document.visibilityState === 'visible' && checkSession()

onMounted(() => {
  if (app.user?.mustChangePassword) profileOpen.value = true
  else if (app.user?.mustSetup2fa) openProfile('security')
  loadWarnings()
  app.loadGroups()
  bootGuide()
  timer = setInterval(() => { checkSession(); loadWarnings() }, 2 * 60 * 1000)
  document.addEventListener('visibilitychange', onVisible)
})
onBeforeUnmount(() => {
  clearInterval(timer)
  tour.active = false
  drawerHook.open = drawerHook.close = null
  drawerHook.isOpen = () => false
  document.removeEventListener('visibilitychange', onVisible)
})
</script>

<style scoped>
.shell { min-height: 100vh; }
.sidebar { position: fixed; inset: 0 auto 0 0; width: var(--sidebar-w); display: flex; flex-direction: column; background: var(--surface); border-right: 1px solid var(--border); z-index: 40; }
.brand { height: var(--header-h); display: flex; align-items: center; padding: 0 18px; border-bottom: 1px solid var(--border); }
.nav { flex: 1; padding: 12px 10px; display: flex; flex-direction: column; gap: 2px; overflow-y: auto; }
.nav-item { display: flex; align-items: center; gap: 12px; padding: 10px 12px; border-radius: 8px; color: var(--text); text-decoration: none; font-size: 14.5px; }
.nav-item:hover { background: var(--surface-2); }
.nav-item.router-link-active { background: var(--primary-soft); color: var(--primary); font-weight: 600; }
.badge { margin-left: auto; }
.nav-sec { display: flex; flex-direction: column; gap: 2px; }
.nav-sec + .nav-sec { margin-top: 10px; }
.nav-head { padding: 4px 12px; font-size: 11.5px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: var(--muted); }
.nav-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.main { margin-left: var(--sidebar-w); min-height: 100vh; display: flex; flex-direction: column; }
.topbar { position: sticky; top: 0; z-index: 30; height: var(--header-h); display: flex; align-items: center; gap: 12px; padding: 0 20px; background: color-mix(in srgb, var(--bg) 85%, transparent); backdrop-filter: blur(8px); border-bottom: 1px solid var(--border); }
.menu-btn { display: none; }
.crumbs { display: flex; align-items: center; gap: 6px; min-width: 0; font-size: 13px; color: var(--muted); white-space: nowrap; }
.crumb { overflow: hidden; text-overflow: ellipsis; }
.crumb.last { color: var(--text); font-weight: 500; }
.sep { flex: none; }
.bell-wrap { display: inline-flex; }
.right { margin-left: auto; display: flex; align-items: center; gap: 4px; flex: none; }
.user-btn { all: unset; display: flex; align-items: center; gap: 8px; padding: 4px 8px 4px 4px; border-radius: 999px; cursor: pointer; }
.user-btn:hover, .user-btn:focus-visible { background: var(--surface-2); }
.avatar { background: var(--primary); color: #fff; }
.user-name { font-size: 14px; max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
main { flex: 1; }
.scrim { display: none; }
@media (max-width: 960px) {
  .sidebar { transform: translateX(-100%); transition: transform 0.2s ease; }
  .sidebar.open { transform: none; box-shadow: 0 0 24px rgba(0, 0, 0, 0.2); }
  .scrim { display: block; position: fixed; inset: 0; background: rgba(0, 0, 0, 0.35); z-index: 35; }
  .main { margin-left: 0; }
  .menu-btn { display: inline-flex; }
  .topbar { padding: 0 8px; gap: 6px; }
  .user-name { display: none; }
  .crumb:not(.last), .sep { display: none; }
}
</style>
