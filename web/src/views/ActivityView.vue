<template>
  <div class="page">
    <div class="page-header"><div><h1>{{ t('nav.activity') }}</h1><p>{{ t('activity.subtitle') }}</p></div></div>
    <div class="filters">
      <n-input v-model:value="f.q" clearable :placeholder="t('activity.search')" class="f-q" @keyup.enter="apply" @clear="apply"><template #prefix><n-icon :component="SearchOutline" /></template></n-input>
      <n-input v-model:value="f.user" clearable :placeholder="t('activity.user')" class="f-u" @keyup.enter="apply" @clear="apply" />
      <n-select v-model:value="f.action" clearable :options="actionOptions" :placeholder="t('activity.action')" class="f-a" @update:value="apply" />
      <n-button @click="apply"><template #icon><n-icon :component="RefreshOutline" /></template>{{ t('common.refresh') }}</n-button>
    </div>
    <div class="surface">
      <n-data-table :columns="columns" :data="rows" :loading="loading" :bordered="false" :single-line="false" :scroll-x="760" :row-key="(r, i) => r.ts + i">
        <template #empty><n-empty :description="t('activity.none')" /></template>
      </n-data-table>
      <div v-if="hasMore" class="more"><n-button secondary :loading="loading" @click="more">{{ t('activity.more') }}</n-button></div>
    </div>
  </div>
</template>

<script setup>
import { computed, h, onMounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { NButton, NDataTable, NEmpty, NIcon, NInput, NSelect, NTag } from 'naive-ui'
import { RefreshOutline, SearchOutline } from '@vicons/ionicons5'
import { api } from '../api'
import { useFeedback } from '../composables'
import { formatBytes, formatDate } from '../utils'

const { t } = useI18n()
const fb = useFeedback()
const rows = ref([])
const loading = ref(false)
const hasMore = ref(false)
const page = ref(1)
const f = reactive({ q: '', user: '', action: null })

const ACTIONS = ['login', 'login-failed', 'logout', 'upload', 'download', 'download-zip', 'delete', 'restore', 'purge', 'mkdir', 'create', 'edit', 'rename', 'copy', 'move', 'zip', 'unzip', 'password-change', 'user-create', 'user-update', 'user-delete', 'settings-update', 'logo-update', 'logo-remove']
const actionOptions = computed(() => ACTIONS.map(a => ({ value: a, label: t(`action.${a}`) })))
const tone = a => (a.includes('failed') || a === 'delete' || a === 'purge' || a === 'user-delete' ? 'error' : a.startsWith('login') || a === 'logout' ? 'info' : a === 'upload' || a === 'restore' ? 'success' : 'default')

async function fetchPage(p) {
  loading.value = true
  try {
    const r = await api.activity({ page: p, pageSize: 25, q: f.q, user: f.user, action: f.action || '' })
    return r
  } catch (e) { fb.fail(e); return null } finally { loading.value = false }
}
async function apply() {
  page.value = 1
  const r = await fetchPage(1)
  if (r) { rows.value = r.items; hasMore.value = r.hasMore }
}
async function more() {
  const r = await fetchPage(page.value + 1)
  if (r) { page.value++; rows.value = rows.value.concat(r.items); hasMore.value = r.hasMore }
}

const detail = r => (r.action === 'upload' && r.detail ? formatBytes(Number(r.detail)) : r.detail || '')
const columns = [
  { title: t('activity.time'), key: 'ts', width: 150, render: r => formatDate(r.ts) },
  { title: t('activity.user'), key: 'user', width: 130, render: r => h('span', { style: 'font-weight:500' }, r.user) },
  { title: t('activity.action'), key: 'action', width: 160, render: r => h(NTag, { size: 'small', round: true, type: tone(r.action), bordered: false }, () => t(`action.${r.action}`)) },
  { title: t('activity.target'), key: 'target', minWidth: 220, render: r => h('div', { style: 'min-width:0' }, [h('div', { class: 'mono truncate', title: r.target }, r.target || '—'), detail(r) ? h('div', { class: 'muted', style: 'font-size:12px' }, detail(r)) : null]) },
  { title: 'IP', key: 'ip', width: 130, render: r => h('span', { class: 'mono muted' }, r.ip) },
]
onMounted(apply)
</script>

<style scoped>
.filters { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 14px; }
.f-q { flex: 2; min-width: 200px; }
.f-u { flex: 1; min-width: 140px; }
.f-a { flex: 1; min-width: 180px; }
.more { padding: 14px; text-align: center; border-top: 1px solid var(--border); }
</style>
