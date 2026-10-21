<template>
  <div>
    <div class="head">
      <n-button :loading="loading" @click="load"><template #icon><n-icon :component="RefreshOutline" /></template>{{ t('common.refresh') }}</n-button>
    </div>
    <div class="surface">
      <n-data-table :columns="columns" :data="rows" :loading="loading" :bordered="false" :single-line="false"
        :scroll-x="narrow ? undefined : 760" table-layout="fixed" :row-key="r => r.id" :pagination="{ pageSize: 25 }"      >
        <template #empty><n-empty :description="t('grants.usersNone')" /></template>
      </n-data-table>
    </div>
  </div>
</template>

<script setup>
import { computed, h, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { NButton, NDataTable, NEmpty, NIcon, NRadioButton, NRadioGroup, NTag } from 'naive-ui'
import { CloseOutline, FolderOutline, RefreshOutline } from '@vicons/ionicons5'
import { api } from '../api'
import { useFeedback, useNarrow } from '../composables'
import { formatDate } from '../utils'

const { t } = useI18n()
const fb = useFeedback()
const rows = ref([])
const loading = ref(false)

async function load() {
  loading.value = true
  try { rows.value = [...(await api.myGrants()).items].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)) } catch (e) { fb.fail(e) } finally { loading.value = false }
}

async function setPerms(g, v) {
  if (v === g.perms) return
  try { await api.updateGrant(g.id, v); g.perms = v; fb.ok(t('grants.updated', { name: targetName(g) })) } catch (e) { fb.fail(e); await load() }
}
async function remove(g) {
  const name = targetName(g)
  if (!(await fb.confirm({ title: t('grants.removeTitle', { name }), content: t('grants.removeBody', { name, folder: g.name }), positive: t('grants.remove'), danger: true }))) return
  try { await api.deleteGrant(g.id); fb.ok(t('grants.removed')) } catch (e) { fb.fail(e) }
  await load()
}

// a grant to a group has no `to`: the group's name stands for the recipient
const targetName = g => (g.toGroup ? g.toGroupName || t('groups.groupLabel') : g.toName || g.to)
const dim = g => (g.active ? '' : ' dim')
const folderCell = g => h('div', { class: `g-folder${dim(g)}` }, [
  h(NIcon, { component: FolderOutline, size: 20, color: '#f59e0b' }),
  h('div', { class: 'g-text' }, [
    h('div', { class: 'g-name' }, g.name),
    h('div', { class: 'muted mono wrap' }, g.path || ''),
    g.active ? null : h(NTag, { size: 'small', round: true, bordered: false, type: 'warning', title: t('grants.inactiveHint') }, () => t('grants.inactive')),
    g.active ? null : h('div', { class: 'muted small' }, t('grants.inactiveHint')),
  ]),
])
const toCell = g => h('div', { class: `g-text${dim(g)}` }, [
  h('div', { class: 'g-name' }, targetName(g)),
  g.toGroup ? h(NTag, { size: 'small', round: true, bordered: false, type: 'info' }, () => t('groups.groupLabel')) : h('div', { class: 'muted mono wrap' }, g.to),
])
const permsCell = g => h('div', { class: dim(g).trim() }, [
  h(NRadioGroup, { value: g.perms, size: 'small', name: `perm-${g.id}`, 'onUpdate:value': v => setPerms(g, v) }, () => [
    h(NRadioButton, { value: 'view', label: t('grants.permView') }),
    h(NRadioButton, { value: 'edit', label: t('grants.permEdit') }),
  ]),
])
const removeBtn = g => h(NButton, { size: 'small', secondary: true, type: 'error', onClick: () => remove(g) }, { default: () => t('grants.remove'), icon: () => h(NIcon, { component: CloseOutline }) })

const narrow = useNarrow()
const columns = computed(() => (narrow.value
  ? [{
      title: t('grants.colFolder'), key: 'name',
      render: g => h('div', { class: 'stacked' }, [
        folderCell(g),
        h('div', { class: `stacked-meta${dim(g)}` }, [h('span', {}, g.toGroup ? `${t('grants.colTo')}: ${t('groups.groupLabel')} ${targetName(g)}` : `${t('grants.colTo')}: ${g.toName || g.to} (${g.to})`), h('span', {}, t('grants.since', { date: formatDate(g.createdAt) }))]),
        h('div', { class: 'stacked-meta' }, [permsCell(g)]),
        h('div', { class: 'stacked-meta' }, [removeBtn(g)]),
      ]),
    }]
  : [
      { title: t('grants.colFolder'), key: 'name', minWidth: 220, render: folderCell },
      { title: t('grants.colTo'), key: 'to', width: 170, render: toCell },
      { title: t('grants.colPerms'), key: 'perms', width: 190, render: permsCell },
      { title: '', key: 'a', width: 130, align: 'right', fixed: 'right', render: removeBtn },
    ]))

onMounted(load)
</script>

<style scoped>
.head { display: flex; justify-content: flex-end; margin-bottom: 14px; }
:deep(.g-folder) { display: flex; align-items: flex-start; gap: 10px; min-width: 0; }
:deep(.g-text) { min-width: 0; display: flex; flex-direction: column; align-items: flex-start; gap: 2px; }
:deep(.g-name) { font-weight: 500; overflow-wrap: anywhere; }
:deep(.wrap) { overflow-wrap: anywhere; }
:deep(.small) { font-size: 12.5px; }
/* a share that opens nothing now: dimmed, but the remove button stays at full strength */
:deep(.dim) { opacity: 0.55; }
:deep(.stacked) { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
:deep(.stacked-meta) { display: flex; align-items: center; gap: 4px 12px; flex-wrap: wrap; font-size: 12.5px; color: var(--muted); padding-left: 30px; overflow-wrap: anywhere; }
</style>
