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
      <div class="side-foot">
        <router-link :to="{ name: 'help' }" class="nav-item small" data-tour="nav-help" @click="drawer = false">
          <n-icon :component="HelpCircleOutline" size="18" /><span class="nav-label">{{ t('nav.help') }}</span>
        </router-link>
      </div>
    </aside>
    <div v-if="drawer" class="scrim" @click="drawer = false" />

    <div class="main">
      <header class="topbar">
        <n-button class="menu-btn" quaternary circle data-tour="menu-toggle" :aria-label="t('nav.menu')" @click="drawer = true">
          <template #icon><n-icon :component="MenuOutline" /></template>
        </n-button>
        <div class="title">{{ pageTitle }}</div>
        <div class="right">
          <span class="bell-wrap" data-tour="bell"><notification-bell @settings="openProfile('notify')" /></span>
          <n-button class="help-btn" quaternary circle data-tour="help-button" :title="t('nav.helpTip')" :aria-label="t('nav.helpTip')" @click="router.push({ name: 'help' })">
            <template #icon><n-icon :component="HelpCircleOutline" /></template>
          </n-button>
          <n-dropdown trigger="click" :options="userOptions" @select="onSelect">
            <button type="button" class="user-btn" data-tour="user-menu">
              <n-avatar round size="small" class="avatar">{{ initial }}</n-avatar>
              <span class="user-name">{{ app.user?.name }}</span>
            </button>
          </n-dropdown>
        </div>
      </header>
      <main><router-view :key="viewKey" /></main>
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
  ContrastOutline, FolderOpenOutline, FolderOutline, GlobeOutline, BookOutline, HelpCircleOutline, KeyOutline, LanguageOutline, LinkOutline, LogOutOutline, MenuOutline, MoonOutline, PeopleCircleOutline, PersonOutline,
  ServerOutline, ShareSocialOutline, SpeedometerOutline, StarOutline, SunnyOutline, TimeOutline, TrashOutline,
} from '@vicons/ionicons5'
import { api } from '../api'
import AppLogo from '../components/AppLogo.vue'
import NotificationBell from '../components/NotificationBell.vue'
import ProfileModal from '../components/ProfileModal.vue'
import SpotlightTour from '../components/SpotlightTour.vue'
import WhatsNewModal from '../components/WhatsNewModal.vue'
import { releasesFor } from '../guide/releases'
import { drawerHook, guide, loadGuide, openWhatsNew, resetGuide, saveSeen, startFullTour, tour } from '../guide/tour'
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
const navItems = computed(() => sections.value.flatMap(sec => sec.items))

const pageTitle = computed(() => (route.meta.system ? t('nav.system') : route.name === 'help' ? t('nav.help') : route.name === 'user-files' ? t('nav.users') : route.name === 'shared' ? t('nav.publicFolder') : route.name === 'groups' ? t('nav.groupFolders') : navItems.value.find(i => i.name === route.name)?.label || ''))
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
  if (!app.isStaff) return
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

// a new user gets the welcome (and the tour), a user who updated gets what is new; nothing while the forced password dialog is up
let guideChecked = false
function showGuide() {
  if (guideChecked || !guide.loaded || !app.user || app.user.mustChangePassword || profileOpen.value) return
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
  if (!app.user || app.user.mustChangePassword) return
  guide.loaded = false
  loadGuide().then(showGuide).catch(() => { /* a nicety */ })
}
watch(() => app.user?.mustChangePassword, (now, before) => { if (before && !now) bootGuide() })
watch(profileOpen, showGuide)
const onVisible = () => document.visibilityState === 'visible' && checkSession()

onMounted(() => {
  if (app.user?.mustChangePassword) profileOpen.value = true
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
.nav-item.small { font-size: 13.5px; color: var(--muted); }
.badge { margin-left: auto; }
.side-foot { padding: 10px; border-top: 1px solid var(--border); }
.nav-sec { display: flex; flex-direction: column; gap: 2px; }
.nav-sec + .nav-sec { margin-top: 10px; }
.nav-head { padding: 4px 12px; font-size: 11.5px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: var(--muted); }
.nav-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.main { margin-left: var(--sidebar-w); min-height: 100vh; display: flex; flex-direction: column; }
.topbar { position: sticky; top: 0; z-index: 30; height: var(--header-h); display: flex; align-items: center; gap: 12px; padding: 0 20px; background: color-mix(in srgb, var(--bg) 85%, transparent); backdrop-filter: blur(8px); border-bottom: 1px solid var(--border); }
.menu-btn { display: none; }
.title { font-weight: 600; font-size: 16px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bell-wrap { display: inline-flex; }
.right { margin-left: auto; display: flex; align-items: center; gap: 4px; flex: none; }
.user-btn { all: unset; display: flex; align-items: center; gap: 8px; padding: 4px 8px 4px 4px; border-radius: 999px; cursor: pointer; }
.user-btn:hover, .user-btn:focus-visible { background: var(--surface-2); }
.avatar { background: var(--primary); color: #fff; }
.user-name { font-size: 14px; max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
main { flex: 1; }
.scrim { display: none; }
@media (max-width: 960px) {
  .sidebar { transform: translateX(-100%); transition: transform 0.2s ease; box-shadow: 0 0 24px rgba(0, 0, 0, 0.2); }
  .sidebar.open { transform: none; }
  .scrim { display: block; position: fixed; inset: 0; background: rgba(0, 0, 0, 0.35); z-index: 35; }
  .main { margin-left: 0; }
  .menu-btn { display: inline-flex; }
  .topbar { padding: 0 8px; gap: 6px; }
  .user-name { display: none; }
}
</style>
