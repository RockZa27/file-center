<template>
  <div class="bell">
    <n-popover v-if="!narrow" trigger="manual" placement="bottom-end" :show="open" :show-arrow="false" raw style="width: 380px; max-width: 94vw" @clickoutside="open = false">
      <template #trigger>
        <n-badge :value="unread" :max="99" :show="unread > 0" :offset="[-4, 4]">
          <n-button quaternary circle :title="t('notify.bell')" :aria-label="t('notify.bell')" data-testid="bell" @click="toggle">
            <template #icon><n-icon :component="NotificationsOutline" /></template>
          </n-button>
        </n-badge>
      </template>
      <div class="pop"><notification-list :items="items" :unread="unread" @open="openItem" @remove="remove" @read-all="readAll" @settings="settings" /></div>
    </n-popover>
    <template v-else>
      <n-badge :value="unread" :max="99" :show="unread > 0" :offset="[-4, 4]">
        <n-button quaternary circle :title="t('notify.bell')" :aria-label="t('notify.bell')" data-testid="bell" @click="toggle">
          <template #icon><n-icon :component="NotificationsOutline" /></template>
        </n-button>
      </n-badge>
      <n-drawer v-model:show="open" placement="bottom" height="75vh" :auto-focus="false">
        <n-drawer-content :native-scrollbar="false" body-content-style="padding:0" closable :title="t('notify.bell')">
          <div class="sheet"><notification-list :items="items" :unread="unread" @open="openItem" @remove="remove" @read-all="readAll" @settings="settings" /></div>
        </n-drawer-content>
      </n-drawer>
    </template>
  </div>
</template>

<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { NBadge, NButton, NDrawer, NDrawerContent, NIcon, NPopover } from 'naive-ui'
import { NotificationsOutline } from '@vicons/ionicons5'
import { api } from '../api'
import { useFeedback, useNarrow } from '../composables'
import NotificationList from './NotificationList.vue'

const emit = defineEmits(['settings'])
const { t } = useI18n()
const router = useRouter()
const fb = useFeedback()
const narrow = useNarrow('(max-width: 640px)')

const open = ref(false)
const items = ref([])
const unread = ref(0)
let timer = null

const visible = () => document.visibilityState === 'visible'

/** the badge: only the unread ones are asked for, and only while the tab is in view */
async function poll() {
  if (!visible()) return
  try {
    const r = await api.notifications(true)
    const changed = r.unread !== unread.value
    unread.value = r.unread
    if (open.value && changed) await loadAll()
  } catch { /* the bell is a nicety: the next poll tries again */ }
}

async function loadAll() {
  const r = await api.notifications(false)
  items.value = r.items
  unread.value = r.unread
}

async function toggle() {
  open.value = !open.value
  if (open.value) { try { await loadAll() } catch (e) { fb.fail(e) } }
}

async function openItem(n) {
  open.value = false
  if (!n.read) {
    n.read = true
    try { unread.value = (await api.notificationsRead([n.id])).unread } catch { /* shown as read; the next poll corrects it */ }
  }
  if (n.link) router.push(n.link)
}

async function remove(n) {
  try {
    await api.notificationDelete(n.id)
    items.value = items.value.filter(i => i.id !== n.id)
    if (!n.read) unread.value = Math.max(0, unread.value - 1)
  } catch (e) { fb.fail(e); await loadAll().catch(() => {}) }
}

async function readAll() {
  try {
    unread.value = (await api.notificationsRead()).unread
    for (const n of items.value) n.read = true
  } catch (e) { fb.fail(e) }
}

function settings() {
  open.value = false
  emit('settings')
}

function start() {
  clearInterval(timer)
  timer = setInterval(poll, 60 * 1000)
}
function stop() { clearInterval(timer); timer = null }
function onVisibility() { if (visible()) { poll(); start() } else stop() }

watch(() => router.currentRoute.value.fullPath, () => { open.value = false })

onMounted(() => {
  poll()
  if (visible()) start()
  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('focus', poll)
})
onBeforeUnmount(() => {
  stop()
  document.removeEventListener('visibilitychange', onVisibility)
  window.removeEventListener('focus', poll)
})
</script>

<style scoped>
.bell { display: inline-flex; }
.pop { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: 0 8px 28px rgba(16, 24, 40, 0.18); max-height: min(70vh, 520px); display: flex; flex-direction: column; overflow: hidden; }
.sheet { display: flex; flex-direction: column; }
</style>
