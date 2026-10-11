<template>
  <div class="page">
    <div class="page-header">
      <div><h1>{{ t('nav.logs') }}</h1><p>{{ t('logs.subtitle') }}</p></div>
      <n-button tag="a" :href="api.logsDownloadUrl()" download secondary>
        <template #icon><n-icon :component="DownloadOutline" /></template>{{ t('logs.download') }}
      </n-button>
    </div>
    <div class="filters">
      <n-input v-model:value="f.q" clearable :placeholder="t('logs.search')" class="f-q" @keyup.enter="apply" @clear="apply"><template #prefix><n-icon :component="SearchOutline" /></template></n-input>
      <n-select v-model:value="f.level" clearable :options="levelOptions" :placeholder="t('logs.allLevels')" class="f-l" @update:value="apply" />
      <n-button @click="apply"><template #icon><n-icon :component="RefreshOutline" /></template>{{ t('common.refresh') }}</n-button>
    </div>
    <div class="surface">
      <n-data-table
        v-model:expanded-row-keys="expanded" :columns="columns" :data="rows" :loading="loading" :bordered="false" :single-line="false"
        :scroll-x="narrow ? undefined : 760" table-layout="fixed" :row-key="r => r.key"
      >
        <template #empty><n-empty :description="t('logs.none')" /></template>
      </n-data-table>
      <div v-if="hasMore" class="more"><n-button secondary :loading="loading" @click="more">{{ t('logs.more') }}</n-button></div>
    </div>
  </div>
</template>

<script setup>
import { computed, h, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import { NButton, NDataTable, NEmpty, NIcon, NInput, NSelect, NTag } from 'naive-ui'
import { DownloadOutline, RefreshOutline, SearchOutline } from '@vicons/ionicons5'
import { api } from '../api'
import { useFeedback } from '../composables'
import { formatDate } from '../utils'

const LEVELS = ['info', 'warn', 'error']
const PAGE_SIZE = 50
const { t } = useI18n()
const fb = useFeedback()
const route = useRoute()
const rows = ref([])
const expanded = ref([])
const loading = ref(false)
const hasMore = ref(false)
const page = ref(1)
// the dashboard links here with ?level=error
const f = reactive({ q: '', level: LEVELS.includes(route.query.level) ? route.query.level : null })

const levelOptions = computed(() => LEVELS.map(l => ({ value: l, label: t(`logs.level.${l}`) })))
const tone = l => (l === 'error' ? 'error' : l === 'warn' ? 'warning' : 'info')

// ── reading a detail: a text, or an object that may hold an error ({ message, code, stack }) one level down
const isObj = v => v !== null && typeof v === 'object'
const short = v => (isObj(v) ? (typeof v.message === 'string' ? v.message : JSON.stringify(v)) : String(v))
function summary(d) {
  if (d === undefined || d === null) return ''
  if (!isObj(d)) return String(d)
  if (typeof d.message === 'string') return d.message
  return Object.entries(d).map(([k, v]) => `${k}: ${short(v)}`).join(' · ')
}
/** the stack traces in a detail, and the detail without them */
function split(d) {
  if (!isObj(d) || Array.isArray(d)) return { stacks: [], rest: d }
  const stacks = []
  const rest = {}
  for (const [k, v] of Object.entries(d)) {
    if (k === 'stack' && typeof v === 'string') stacks.push({ label: '', text: v })
    else if (isObj(v) && !Array.isArray(v) && typeof v.stack === 'string') {
      stacks.push({ label: k, text: v.stack })
      const { stack, ...others } = v
      rest[k] = others
    } else rest[k] = v
  }
  return { stacks, rest }
}
function prepare(e, key) {
  const text = summary(e.detail)
  const { stacks, rest } = split(e.detail)
  const full = typeof e.detail === 'string' ? e.detail : e.detail === undefined ? '' : JSON.stringify(rest, null, 2)
  // up to three lines show in the table; anything longer, multi-line or with a stack trace opens below the row
  const long = stacks.length > 0 || text.length > 100 || text.includes('\n') || (isObj(e.detail) && JSON.stringify(e.detail).length > 160)
  return { ...e, key, text, full, stacks, long }
}

async function fetchPage(p) {
  loading.value = true
  try {
    return await api.logs({ page: p, pageSize: PAGE_SIZE, q: f.q.trim(), level: f.level || '' })
  } catch (e) { fb.fail(e); return null } finally { loading.value = false }
}
async function apply() {
  page.value = 1
  const r = await fetchPage(1)
  if (r) { rows.value = r.items.map((e, i) => prepare(e, i)); expanded.value = []; hasMore.value = r.hasMore }
}
async function more() {
  const r = await fetchPage(page.value + 1)
  if (!r) return
  page.value++
  const start = rows.value.length
  rows.value = rows.value.concat(r.items.map((e, i) => prepare(e, start + i)))
  hasMore.value = r.hasMore
}

const toggle = r => {
  expanded.value = expanded.value.includes(r.key) ? expanded.value.filter(k => k !== r.key) : [...expanded.value, r.key]
}

function renderFull(r) {
  const parts = []
  if (r.full && r.full !== '{}') parts.push(h('pre', { class: 'log-pre' }, r.full))
  for (const s of r.stacks) {
    parts.push(h('div', { class: 'log-label' }, s.label ? `${t('logs.stack')} (${s.label})` : t('logs.stack')))
    parts.push(h('pre', { class: 'log-pre stack' }, s.text))
  }
  return h('div', { class: 'log-full' }, parts)
}

// on a phone the four columns would push event and detail off screen: one stacked column instead
const narrowQuery = window.matchMedia('(max-width: 640px)')
const narrow = ref(narrowQuery.matches)
const onWidth = e => { narrow.value = e.matches }

const levelTag = r => h(NTag, { size: 'small', round: true, type: tone(r.level), bordered: false }, () => t(`logs.level.${r.level}`))
const detailCell = r => (r.text
  ? h('div', { class: ['detail', { link: r.long }], onClick: r.long ? () => toggle(r) : undefined }, r.text)
  : h('span', { class: 'muted' }, '—'))
const expandCol = { type: 'expand', width: 40, expandable: r => r.long, renderExpand: renderFull }

const columns = computed(() => (narrow.value
  ? [
      expandCol,
      {
        title: t('logs.event'), key: 'event',
        render: r => h('div', { class: 'stacked' }, [
          h('div', { class: 'stacked-head' }, [levelTag(r), h('span', { class: 'muted nowrap' }, formatDate(r.ts))]),
          h('div', { class: 'mono event' }, r.event),
          r.text ? detailCell(r) : null,
        ]),
      },
    ]
  : [
      expandCol,
      { title: t('logs.time'), key: 'ts', width: 150, render: r => h('span', { class: 'nowrap' }, formatDate(r.ts)) },
      { title: t('logs.levelTitle'), key: 'level', width: 110, render: levelTag },
      { title: t('logs.event'), key: 'event', width: 190, render: r => h('span', { class: 'mono event' }, r.event) },
      { title: t('logs.detail'), key: 'detail', minWidth: 260, render: detailCell },
    ]))

onMounted(() => { narrowQuery.addEventListener('change', onWidth); apply() })
onBeforeUnmount(() => narrowQuery.removeEventListener('change', onWidth))
</script>

<style scoped>
.filters { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 14px; }
.f-q { flex: 2; min-width: 200px; }
.f-l { flex: 1; min-width: 160px; max-width: 260px; }
.more { padding: 14px; text-align: center; border-top: 1px solid var(--border); }
.nowrap { white-space: nowrap; }
:deep(.event) { overflow-wrap: anywhere; }
:deep(.detail) {
  min-width: 0; font-size: 13.5px; overflow-wrap: anywhere;
  display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; line-clamp: 3; overflow: hidden;
}
:deep(.detail.link) { cursor: pointer; }
:deep(.detail.link:hover) { color: var(--primary); }
:deep(.log-full) { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
:deep(.log-label) { font-size: 12.5px; color: var(--muted); font-weight: 500; }
:deep(.log-pre) {
  margin: 0; padding: 10px 12px; border-radius: 8px; background: var(--surface-2); border: 1px solid var(--border);
  font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace; font-size: 12.5px; line-height: 1.5;
  white-space: pre-wrap; overflow-wrap: anywhere; max-height: 420px; overflow: auto;
}
:deep(.log-pre.stack) { white-space: pre; overflow-wrap: normal; }
:deep(.stacked) { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
:deep(.stacked-head) { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12.5px; }
@media (max-width: 960px) {
  .f-l { max-width: none; }
  /* between phone and desktop the table scrolls sideways: keep the opened detail in view, as wide as the screen */
  :deep(.log-full) { position: sticky; left: 12px; max-width: calc(100vw - 76px); }
}
@media (max-width: 768px) {
  :deep(.log-full) { max-width: calc(100vw - 60px); }
}
</style>
