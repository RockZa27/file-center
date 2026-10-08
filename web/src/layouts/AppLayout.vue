<template>
  <div class="shell">
    <aside class="sidebar" :class="{ open: drawer }">
      <div class="brand"><app-logo :to="{ name: 'files' }" /></div>
      <nav class="nav">
        <router-link v-for="item in navItems" :key="item.name" :to="{ name: item.name }" class="nav-item" @click="drawer = false">
          <n-icon :component="item.icon" size="19" />
          <span>{{ item.label }}</span>
          <n-badge v-if="item.badge" :value="item.badge" :type="item.badgeType" class="badge" />
        </router-link>
      </nav>
      <div v-if="app.isAdmin && app.config.publicEnabled" class="side-foot">
        <router-link :to="{ name: 'shared' }" class="nav-item small" @click="drawer = false">
          <n-icon :component="GlobeOutline" size="18" /><span>{{ t('nav.publicPage') }}</span>
        </router-link>
      </div>
    </aside>
    <div v-if="drawer" class="scrim" @click="drawer = false" />

    <div class="main">
      <header class="topbar">
        <n-button class="menu-btn" quaternary circle @click="drawer = true">
          <template #icon><n-icon :component="MenuOutline" /></template>
        </n-button>
        <div class="title">{{ pageTitle }}</div>
        <div class="right">
          <preference-controls />
          <n-dropdown trigger="click" :options="userOptions" @select="onSelect">
            <button type="button" class="user-btn">
              <n-avatar round size="small" class="avatar">{{ initial }}</n-avatar>
              <span class="user-name">{{ app.user?.name }}</span>
            </button>
          </n-dropdown>
        </div>
      </header>
      <main><router-view :key="viewKey" /></main>
    </div>
    <profile-modal v-model:show="profileOpen" />
  </div>
</template>

<script setup>
import { computed, h, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { NAvatar, NBadge, NButton, NDropdown, NIcon } from 'naive-ui'
import {
  FolderOutline, GlobeOutline, KeyOutline, LogOutOutline, MenuOutline, PeopleOutline, SettingsOutline,
  SpeedometerOutline, TimeOutline, TrashOutline,
} from '@vicons/ionicons5'
import { api } from '../api'
import AppLogo from '../components/AppLogo.vue'
import PreferenceControls from '../components/PreferenceControls.vue'
import ProfileModal from '../components/ProfileModal.vue'
import { useAppStore } from '../store'

const { t } = useI18n()
const app = useAppStore()
const route = useRoute()
const router = useRouter()

const drawer = ref(false)
const profileOpen = ref(false)
const warnings = ref([])
let timer = null

const alertCount = computed(() => warnings.value.filter(w => w.level !== 'info').length)
const critical = computed(() => warnings.value.some(w => w.level === 'critical'))

const navItems = computed(() => {
  const items = [{ name: 'files', label: t('nav.files'), icon: FolderOutline }]
  if (!app.isAdmin && app.hasSpace('public')) items.push({ name: 'shared', label: t('nav.publicFolder'), icon: GlobeOutline })
  if (app.isAdmin) {
    items.push(
      { name: 'dashboard', label: t('nav.dashboard'), icon: SpeedometerOutline, badge: alertCount.value, badgeType: critical.value ? 'error' : 'warning' },
      { name: 'users', label: t('nav.users'), icon: PeopleOutline },
      { name: 'activity', label: t('nav.activity'), icon: TimeOutline },
      { name: 'trash', label: t('nav.trash'), icon: TrashOutline },
      { name: 'settings', label: t('nav.settings'), icon: SettingsOutline },
    )
  }
  return items
})

const pageTitle = computed(() => (route.name === 'shared' ? t('nav.publicFolder') : navItems.value.find(i => i.name === route.name)?.label || ''))
const initial = computed(() => (app.user?.name || '?').trim().slice(0, 1).toUpperCase())

const userOptions = computed(() => [
  {
    key: 'header', type: 'render',
    render: () => h('div', { style: 'padding:8px 14px;min-width:180px' }, [
      h('div', { style: 'font-weight:600' }, app.user?.name),
      h('div', { style: 'font-size:12px;color:var(--muted)' }, `${app.user?.username}${app.isAdmin ? ' · ' + t('nav.admin') : ''}`),
    ]),
  },
  { type: 'divider', key: 'd' },
  { key: 'profile', label: t('nav.changePassword'), icon: () => h(NIcon, { component: KeyOutline }) },
  { key: 'logout', label: t('nav.logout'), icon: () => h(NIcon, { component: LogOutOutline }) },
])

async function onSelect(key) {
  if (key === 'profile') profileOpen.value = true
  if (key === 'logout') {
    await app.logout()
    router.push({ name: app.publicAvailable ? 'public' : 'login' })
  }
}

async function loadWarnings() {
  if (!app.isAdmin) return
  try { warnings.value = (await api.status()).warnings } catch { /* the dashboard shows errors */ }
}

// the session can end on the server (timeout, password change, restart)
async function checkSession() {
  try { await app.refresh() } catch { return }
  if (!app.user) router.replace({ name: 'login' })
}
// whatever call noticed that the session is gone, leave the protected area at once
watch(() => app.user, u => { if (!u) router.replace({ name: 'login' }) })
// the server refuses everything until a handed-out password is changed: reload the page once it is
const viewKey = ref(0)
watch(() => app.user?.mustChangePassword, (now, before) => {
  if (before && !now) { viewKey.value++; loadWarnings() }
})
const onVisible = () => document.visibilityState === 'visible' && checkSession()

onMounted(() => {
  if (app.user?.mustChangePassword) profileOpen.value = true
  loadWarnings()
  timer = setInterval(() => { checkSession(); loadWarnings() }, 2 * 60 * 1000)
  document.addEventListener('visibilitychange', onVisible)
})
onBeforeUnmount(() => {
  clearInterval(timer)
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
.main { margin-left: var(--sidebar-w); min-height: 100vh; display: flex; flex-direction: column; }
.topbar { position: sticky; top: 0; z-index: 30; height: var(--header-h); display: flex; align-items: center; gap: 12px; padding: 0 20px; background: color-mix(in srgb, var(--bg) 85%, transparent); backdrop-filter: blur(8px); border-bottom: 1px solid var(--border); }
.menu-btn { display: none; }
.title { font-weight: 600; font-size: 16px; }
.right { margin-left: auto; display: flex; align-items: center; gap: 8px; }
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
  .topbar { padding: 0 12px; }
  .user-name { display: none; }
}
</style>
