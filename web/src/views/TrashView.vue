<template>
  <div class="page">
    <div class="page-header">
      <div><h1>{{ t('nav.trash') }}</h1><p>{{ t('trash.subtitle', { days: retention }) }}</p></div>
      <n-button type="error" secondary :disabled="!items.length" @click="emptyAll"><template #icon><n-icon :component="TrashBinOutline" /></template>{{ t('trash.empty') }}</n-button>
    </div>
    <div class="surface">
      <n-data-table :columns="columns" :data="items" :loading="loading" :bordered="false" :single-line="false" :scroll-x="720" :row-key="r => r.id" :pagination="{ pageSize: 25 }">
        <template #empty><n-empty :description="t('trash.none')" /></template>
      </n-data-table>
    </div>
  </div>
</template>

<script setup>
import { h, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { NButton, NDataTable, NEmpty, NIcon, NTag } from 'naive-ui'
import { ArrowUndoOutline, CloseOutline, TrashBinOutline } from '@vicons/ionicons5'
import { api } from '../api'
import FileIcon from '../components/FileIcon.vue'
import { useFeedback } from '../composables'
import { formatBytes, formatDate } from '../utils'

const { t } = useI18n()
const fb = useFeedback()
const items = ref([])
const loading = ref(false)
const retention = ref(30)

async function load() {
  loading.value = true
  try { const r = await api.trash(); items.value = r.items; retention.value = r.retentionDays } catch (e) { fb.fail(e) } finally { loading.value = false }
}

const daysLeft = row => Math.max(0, Math.ceil(retention.value - (Date.now() - Date.parse(row.deletedAt)) / 86_400_000))

async function restore(row) {
  try { const r = await api.restore(row.id); fb.ok(t('trash.restored', { path: r.restoredTo })); await load() } catch (e) { fb.fail(e) }
}
async function purge(row) {
  if (!(await fb.confirm({ title: t('trash.purge'), content: t('trash.purgeConfirm', { name: row.name }), positive: t('trash.purge'), danger: true }))) return
  try { await api.purge(row.id); await load() } catch (e) { fb.fail(e) }
}
async function emptyAll() {
  if (!(await fb.confirm({ title: t('trash.empty'), content: t('trash.emptyConfirm', { n: items.value.length }), positive: t('trash.empty'), danger: true }))) return
  try { await api.purge(); fb.ok(t('files.done')); await load() } catch (e) { fb.fail(e) }
}

const columns = [
  {
    title: t('common.name'), key: 'name', minWidth: 200,
    render: r => h('div', { style: 'display:flex;align-items:center;gap:10px;min-width:0' }, [
      h(FileIcon, { item: { name: r.name, type: r.type }, size: 20 }),
      h('div', { style: 'min-width:0' }, [h('div', { class: 'truncate' }, r.name), h('div', { class: 'muted mono truncate' }, r.originalPath)]),
    ]),
  },
  { title: t('common.size'), key: 'size', width: 100, render: r => (r.type === 'dir' ? formatBytes(r.size) : formatBytes(r.size)) },
  { title: t('trash.deletedBy'), key: 'deletedBy', width: 130 },
  { title: t('trash.deletedAt'), key: 'deletedAt', width: 150, render: r => formatDate(r.deletedAt) },
  { title: t('trash.left'), key: 'left', width: 110, render: r => h(NTag, { size: 'small', round: true, type: daysLeft(r) <= 3 ? 'warning' : 'default' }, () => t('trash.days', { n: daysLeft(r) })) },
  {
    title: '', key: 'a', width: 190, align: 'right',
    render: r => h('div', { style: 'display:flex;gap:6px;justify-content:flex-end' }, [
      h(NButton, { size: 'small', secondary: true, type: 'primary', onClick: () => restore(r) }, { default: () => t('trash.restore'), icon: () => h(NIcon, { component: ArrowUndoOutline }) }),
      h(NButton, { size: 'small', quaternary: true, type: 'error', onClick: () => purge(r) }, { icon: () => h(NIcon, { component: CloseOutline }) }),
    ]),
  },
]
onMounted(load)
</script>
