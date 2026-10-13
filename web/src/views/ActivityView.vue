<template>
  <div class="page">
    <div class="page-header"><div><h1>{{ t('nav.activity') }}</h1><p>{{ t('activity.subtitle') }}</p></div></div>
    <div class="filters">
      <n-input v-model:value="f.q" clearable :placeholder="t('activity.search')" class="f-q" @keyup.enter="apply" @clear="apply"><template #prefix><n-icon :component="SearchOutline" /></template></n-input>
      <n-input v-model:value="f.user" clearable :placeholder="t('activity.user')" class="f-u" @keyup.enter="apply" @clear="apply" />
      <!-- the menu grows to its longest label (leftward, so it stays on a phone screen) instead of cutting labels to the box width -->
      <n-select
        v-model:value="f.action" clearable :options="actionOptions" :placeholder="t('activity.action')" class="f-a" @update:value="apply"
        :consistent-menu-width="false" placement="bottom-end" :menu-props="{ style: 'max-width: calc(100vw - 32px)' }"
      />
      <n-button @click="apply"><template #icon><n-icon :component="RefreshOutline" /></template>{{ t('common.refresh') }}</n-button>
      <n-button tag="a" :href="exportUrl" secondary :loading="saving !== null" :title="t('activity.exportHint')" @click="exportCsv"><template #icon><n-icon :component="DownloadOutline" /></template>{{ t('activity.export') }}</n-button>
    </div>
    <div class="surface">
      <n-data-table :columns="columns" :data="rows" :loading="loading" :bordered="false" :single-line="false"
        :scroll-x="narrow ? undefined : 740" table-layout="fixed" :row-key="r => r.key"
      >
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
import { DownloadOutline, RefreshOutline, SearchOutline } from '@vicons/ionicons5'
import { api } from '../api'
import { useDownload, useFeedback, useNarrow } from '../composables'
import { formatBytes, formatDate } from '../utils'

const { t } = useI18n()
const fb = useFeedback()
const rows = ref([])
const loading = ref(false)
const hasMore = ref(false)
const page = ref(1)
const f = reactive({ q: '', user: '', action: null })

const ACTIONS = ['login', 'login-failed', 'logout', 'upload', 'download', 'download-zip', 'delete', 'restore', 'purge', 'mkdir', 'create', 'edit', 'rename', 'copy', 'move', 'zip', 'unzip', 'password-change', 'user-create', 'user-update', 'user-delete', 'settings-update', 'logo-update', 'logo-remove', 'update-stage', 'update-apply', 'update-apply-unsigned', 'update-rollback', 'update-denied', 'backup-create', 'backup-download', 'backup-delete', 'backup-restore', 'backup-restore-denied', 'logs-download', 'activity-export', 'update-fetch', 'share-create', 'share-download', 'share-revoke', 'alert-test']
// the file holds what the filter boxes show; the click also applies them, so the table matches the file
const exportUrl = computed(() => api.activityExportUrl({ q: f.q, user: f.user, action: f.action || '' }))
const { busy: saving, follow } = useDownload()
async function exportCsv(e) {
  // signed out, the table would only repeat the same error: refresh it after the file is on its way
  if (await follow(e, exportUrl.value, { admin: true })) apply()
}
const actionOptions = computed(() => ACTIONS.map(a => ({ value: a, label: t(`action.${a}`) })))
const tone = a => (a.includes('failed') || a === 'delete' || a === 'purge' || a === 'user-delete' || a === 'update-denied' || a === 'backup-delete' || a === 'backup-restore-denied' ? 'error' : a.startsWith('login') || a === 'logout' ? 'info' : a === 'upload' || a === 'restore' || a === 'backup-create' || a === 'backup-restore' ? 'success' : 'default')

// the table hands row-key only the row, and several events can share one timestamp: number the rows instead
const keyed = (items, start) => items.map((e, i) => ({ ...e, key: start + i }))

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
  if (r) { rows.value = keyed(r.items, 0); hasMore.value = r.hasMore }
}
async function more() {
  const r = await fetchPage(page.value + 1)
  if (r) { page.value++; rows.value = rows.value.concat(keyed(r.items, rows.value.length)); hasMore.value = r.hasMore }
}

const detail = r => (r.action === 'upload' && r.detail ? formatBytes(Number(r.detail)) : r.detail || '')
const actionTag = r => h(NTag, { size: 'small', round: true, type: tone(r.action), bordered: false }, () => t(`action.${r.action}`))

// on a phone five columns leave only time and user on screen: one stacked card per event instead
const narrow = useNarrow()
const columns = computed(() => (narrow.value
  ? [{
      title: t('activity.event'), key: 'event',
      render: r => h('div', { class: 'stacked' }, [
        h('div', { class: 'stacked-head' }, [h('span', { class: 'muted nowrap' }, formatDate(r.ts)), h('span', { class: 'who' }, r.user)]),
        h('div', {}, [actionTag(r)]),
        r.target ? h('div', { class: 'mono target', title: r.target }, r.target) : null,
        detail(r) ? h('div', { class: 'muted small wrap' }, detail(r)) : null,
        r.ip ? h('div', { class: 'mono muted' }, `IP ${r.ip}`) : null,
      ]),
    }]
  : [
      { title: t('activity.time'), key: 'ts', width: 150, render: r => formatDate(r.ts) },
      { title: t('activity.user'), key: 'user', width: 130, render: r => h('span', { style: 'font-weight:500' }, r.user) },
      { title: t('activity.action'), key: 'action', width: 160, render: actionTag },
      { title: t('activity.target'), key: 'target', minWidth: 170, render: r => h('div', { style: 'min-width:0' }, [h('div', { class: 'mono truncate', title: r.target }, r.target || '—'), detail(r) ? h('div', { class: 'muted', style: 'font-size:12px' }, detail(r)) : null]) },
      { title: 'IP', key: 'ip', width: 130, render: r => h('span', { class: 'mono muted' }, r.ip) },
    ]))
onMounted(apply)
</script>

<style scoped>
.filters { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 14px; }
.f-q { flex: 2; min-width: 200px; }
.f-u { flex: 1; min-width: 140px; }
.f-a { flex: 1; min-width: 180px; }
.more { padding: 14px; text-align: center; border-top: 1px solid var(--border); }
.nowrap { white-space: nowrap; }
:deep(.stacked) { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; min-width: 0; }
:deep(.stacked > *) { max-width: 100%; }
:deep(.stacked-head) { display: flex; align-items: baseline; gap: 4px 10px; flex-wrap: wrap; font-size: 12.5px; }
:deep(.who) { font-weight: 500; font-size: 14px; overflow-wrap: anywhere; }
:deep(.target) {
  overflow-wrap: anywhere;
  display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; line-clamp: 3; overflow: hidden;
}
:deep(.small) { font-size: 12px; }
:deep(.wrap) { overflow-wrap: anywhere; }
@media (max-width: 640px) {
  /* two filter boxes side by side, then the two buttons side by side, each half the row */
  .filters { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
  .f-q { grid-column: 1 / -1; }
  .f-q, .f-u, .f-a { min-width: 0; }
}
</style>
