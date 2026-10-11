<template>
  <div class="page">
    <div class="page-header">
      <div><h1>{{ t('nav.trash') }}</h1><p>{{ t('trash.subtitle', { days: retention }) }}</p></div>
      <n-button type="error" secondary :disabled="!items.length" @click="emptyAll"><template #icon><n-icon :component="TrashBinOutline" /></template>{{ t('trash.empty') }}</n-button>
    </div>
    <div class="surface">
      <n-data-table :columns="columns" :data="items" :loading="loading" :bordered="false" :single-line="false"
        :scroll-x="narrow ? undefined : 880" table-layout="fixed" :row-key="r => r.id" :pagination="{ pageSize: 25 }"
      >
        <template #empty><n-empty :description="t('trash.none')" /></template>
      </n-data-table>
    </div>
  </div>
</template>

<script setup>
import { computed, h, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { NButton, NDataTable, NEmpty, NIcon, NTag } from 'naive-ui'
import { ArrowUndoOutline, CloseOutline, TrashBinOutline } from '@vicons/ionicons5'
import { api } from '../api'
import FileIcon from '../components/FileIcon.vue'
import { useFeedback, useNarrow } from '../composables'
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

const nameCell = r => h('div', { class: 'name-cell' }, [
  h(FileIcon, { item: { name: r.name, type: r.type }, size: 20 }),
  h('div', { style: 'min-width:0' }, [h('div', { class: 'truncate', title: r.name }, r.name), h('div', { class: 'muted mono truncate', title: r.originalPath }, r.originalPath)]),
])
const leftTag = r => h(NTag, { size: 'small', round: true, type: daysLeft(r) <= 3 ? 'warning' : 'default' }, () => t('trash.days', { n: daysLeft(r) }))
const actions = r => h('div', { class: 'row-actions' }, [
  h(NButton, { size: 'small', secondary: true, type: 'primary', onClick: () => restore(r) }, { default: () => t('trash.restore'), icon: () => h(NIcon, { component: ArrowUndoOutline }) }),
  h(NButton, { size: 'small', quaternary: true, type: 'error', title: t('trash.purge'), 'aria-label': t('trash.purge'), onClick: () => purge(r) }, { icon: () => h(NIcon, { component: CloseOutline }) }),
])

// on a phone the restore and delete buttons sat off screen to the right: one stacked card per item instead
const narrow = useNarrow()
const columns = computed(() => (narrow.value
  ? [{
      title: t('common.name'), key: 'name',
      render: r => h('div', { class: 'stacked' }, [
        nameCell(r),
        h('div', { class: 'stacked-meta' }, [
          h('span', {}, formatBytes(r.size)),
          h('span', {}, `${t('trash.deletedBy')} ${r.deletedBy}`),
          h('span', {}, formatDate(r.deletedAt)),
          leftTag(r),
        ]),
        actions(r),
      ]),
    }]
  : [
      { title: t('common.name'), key: 'name', minWidth: 200, render: nameCell },
      { title: t('common.size'), key: 'size', width: 100, render: r => formatBytes(r.size) },
      { title: t('trash.deletedBy'), key: 'deletedBy', width: 130 },
      { title: t('trash.deletedAt'), key: 'deletedAt', width: 150, render: r => formatDate(r.deletedAt) },
      { title: t('trash.left'), key: 'left', width: 110, render: leftTag },
      { title: '', key: 'a', width: 190, align: 'right', fixed: 'right', render: actions },
    ]))
onMounted(load)
</script>

<style scoped>
:deep(.name-cell) { display: flex; align-items: center; gap: 10px; min-width: 0; }
:deep(.row-actions) { display: flex; gap: 6px; justify-content: flex-end; }
:deep(.stacked) { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
:deep(.stacked-meta) { display: flex; align-items: center; gap: 4px 12px; flex-wrap: wrap; font-size: 12.5px; color: var(--muted); padding-left: 30px; }
:deep(.stacked .row-actions) { justify-content: flex-start; padding-left: 30px; }
/* a phone can not hover for the title tooltip: show the whole name and path, wrapped */
:deep(.stacked .name-cell) { align-items: flex-start; }
:deep(.stacked .name-cell .truncate) { white-space: normal; overflow-wrap: anywhere; text-overflow: clip; }
</style>
