<template>
  <n-modal :show="show" preset="card" :title="t('search.title')" style="width: min(660px, 94vw)" @update:show="v => emit('update:show', v)" @after-enter="input?.focus()">
    <n-input ref="input" v-model:value="q" clearable :placeholder="t('search.placeholder')" @update:value="onType" @keydown.enter.prevent="searchNow" @keydown.down.prevent="focusRow(0)">
      <template #prefix><n-icon :component="SearchOutline" /></template>
    </n-input>
    <div class="bar">
      <n-button size="small" :type="activeCount ? 'primary' : 'default'" secondary :aria-expanded="f.open" @click="f.open = !f.open">
        <template #icon><n-icon :component="OptionsOutline" /></template>
        {{ t('search.filters') }}<template v-if="activeCount"> ({{ activeCount }})</template>
      </n-button>
      <n-radio-group v-model:value="f.scope" size="small" :aria-label="t('search.scope')">
        <n-radio-button value="here" :title="start">{{ t('search.here') }}</n-radio-button>
        <n-radio-button value="space">{{ t('search.whole') }}</n-radio-button>
      </n-radio-group>
      <n-button v-if="activeCount" size="small" quaternary @click="resetFilters">{{ t('search.reset') }}</n-button>
    </div>
    <div v-if="scopeFolder" class="muted scope truncate">{{ t('search.inFolder', { path: scopeFolder }) }}</div>

    <div v-if="f.open" class="filters">
      <label class="fld">
        <span class="lbl">{{ t('search.type') }}</span>
        <n-select v-model:value="f.type" :options="typeOptions" :placeholder="t('search.type')" size="small" />
      </label>
      <label class="fld wide">
        <span class="lbl">{{ t('search.ext') }}</span>
        <n-select v-model:value="f.ext" multiple filterable tag :show-arrow="false" :options="[]" :placeholder="t('search.extPlaceholder')" size="small" :show="false" />
      </label>
      <label class="fld">
        <span class="lbl">{{ t('search.from') }}</span>
        <n-date-picker v-model:value="f.from" type="date" clearable size="small" :placeholder="t('search.pickDate')" />
      </label>
      <label class="fld">
        <span class="lbl">{{ t('search.to') }}</span>
        <n-date-picker v-model:value="f.to" type="date" clearable size="small" :placeholder="t('search.pickDate')" />
      </label>
      <div class="fld">
        <span class="lbl">{{ t('search.minSize') }}</span>
        <div class="pair">
          <n-input-number v-model:value="f.minSize" :min="0" clearable :show-button="false" size="small" :placeholder="t('search.sizePlaceholder')" :input-props="{ inputmode: 'decimal', 'aria-label': t('search.minSize') }" />
          <n-select v-model:value="f.minUnit" :options="unitOptions" size="small" class="unit" :placeholder="t('search.unit')" />
        </div>
      </div>
      <div class="fld">
        <span class="lbl">{{ t('search.maxSize') }}</span>
        <div class="pair">
          <n-input-number v-model:value="f.maxSize" :min="0" clearable :show-button="false" size="small" :placeholder="t('search.sizePlaceholder')" :input-props="{ inputmode: 'decimal', 'aria-label': t('search.maxSize') }" />
          <n-select v-model:value="f.maxUnit" :options="unitOptions" size="small" class="unit" :placeholder="t('search.unit')" />
        </div>
      </div>
      <label class="fld">
        <span class="lbl">{{ t('search.sort') }}</span>
        <n-select v-model:value="f.sort" :options="sortOptions" size="small" :placeholder="t('search.sort')" />
      </label>
      <label class="fld">
        <span class="lbl">{{ t('search.order') }}</span>
        <n-select v-model:value="f.order" :options="orderOptions" size="small" :placeholder="t('search.order')" />
      </label>
    </div>

    <div v-if="searched && !indexed" class="muted note">{{ t('search.building') }}</div>
    <n-spin :show="loading">
      <div ref="list" class="results" @keydown="onListKey">
        <button v-for="r in results" :key="r.path" type="button" class="row-btn" @click="pick(r)">
          <file-icon :item="r" :size="22" />
          <div class="grow">
            <div class="nm wrap">{{ r.name }}</div>
            <div class="muted p wrap">{{ parentPath(r.path) }}</div>
            <div class="muted meta"><span v-if="r.type === 'file'">{{ formatBytes(r.size) }}</span><span>{{ formatDate(r.mtime) }}</span></div>
          </div>
        </button>
        <div v-if="searched && !loading && !results.length" class="muted none">{{ t('search.noResults') }}</div>
        <div v-if="!searched" class="muted none">{{ t('search.hint') }}</div>
        <div v-if="truncated" class="muted none">{{ t('search.truncated') }}</div>
      </div>
    </n-spin>
  </n-modal>
</template>

<script>
import { reactive } from 'vue'

/** the filters live outside the component: closing and opening the modal (or another file browser) keeps them for the session */
const filters = reactive({
  open: false, scope: 'space', type: 'all', ext: [], from: null, to: null,
  minSize: null, minUnit: 'KB', maxSize: null, maxUnit: 'MB', sort: 'name', order: 'asc',
})
const DEFAULTS = JSON.parse(JSON.stringify(filters))
const POWER = { KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 }
</script>

<script setup>
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { NButton, NDatePicker, NIcon, NInput, NInputNumber, NModal, NRadioButton, NRadioGroup, NSelect, NSpin } from 'naive-ui'
import { OptionsOutline, SearchOutline } from '@vicons/ionicons5'
import { api } from '../api'
import { useFeedback } from '../composables'
import { formatBytes, formatDate, parentPath } from '../utils'
import FileIcon from './FileIcon.vue'

const props = defineProps({ show: Boolean, space: { type: String, required: true }, start: { type: String, default: '/' } })
const emit = defineEmits(['update:show', 'select'])
const { t } = useI18n()
const fb = useFeedback()
const f = filters
const input = ref(null)
const list = ref(null)
const q = ref('')
const results = ref([])
const loading = ref(false)
const searched = ref(false)
const truncated = ref(false)
const indexed = ref(true)
let timer = null
let ticket = 0

const typeOptions = computed(() => [
  { label: t('search.typeAll'), value: 'all' }, { label: t('search.typeFile'), value: 'file' }, { label: t('search.typeDir'), value: 'dir' },
])
const sortOptions = computed(() => [
  { label: t('search.sortName'), value: 'name' }, { label: t('search.sortMtime'), value: 'mtime' }, { label: t('search.sortSize'), value: 'size' },
])
const orderOptions = computed(() => [{ label: t('search.asc'), value: 'asc' }, { label: t('search.desc'), value: 'desc' }])
const unitOptions = Object.keys(POWER).map(u => ({ label: u, value: u }))

/** the folder the search is limited to, shown only when it is not the whole space */
const scopeFolder = computed(() => (f.scope === 'here' && props.start !== '/' ? props.start : ''))
const activeCount = computed(() => [
  f.type !== 'all', f.ext.length, f.from, f.to, f.minSize !== null, f.maxSize !== null, f.sort !== 'name' || f.order !== 'asc',
].filter(Boolean).length)

function params() {
  const p = { sort: f.sort, order: f.order }
  if (f.type !== 'all') p.type = f.type
  if (f.ext.length) p.ext = f.ext.map(e => String(e).trim().replace(/^\./, '')).filter(Boolean).join(',')
  if (f.from) p.from = new Date(f.from).toISOString()
  if (f.to) p.to = new Date(f.to + 86_400_000 - 1).toISOString() // the whole chosen day
  if (f.minSize !== null && f.minSize !== undefined) p.minSize = Math.round(f.minSize * POWER[f.minUnit])
  if (f.maxSize !== null && f.maxSize !== undefined) p.maxSize = Math.round(f.maxSize * POWER[f.maxUnit])
  return p
}

async function run() {
  const v = q.value.trim()
  if (!v) { results.value = []; searched.value = false; loading.value = false; return }
  const mine = ++ticket
  loading.value = true
  try {
    const res = await api.search(props.space, v, f.scope === 'here' ? props.start : '/', params())
    if (mine !== ticket) return
    results.value = res.results
    truncated.value = res.truncated
    indexed.value = res.indexed !== false
    searched.value = true
  } catch (e) { if (mine === ticket) fb.fail(e) } finally { if (mine === ticket) loading.value = false }
}

function onType() {
  clearTimeout(timer)
  if (!q.value.trim()) { ticket++; results.value = []; searched.value = false; loading.value = false; return }
  timer = setTimeout(run, 300)
}
/** Enter in the box: search now, without waiting for the pause */
function searchNow() { clearTimeout(timer); run() }

// a changed filter or scope searches again (a pause after the last change)
watch(filters, () => { if (props.show && q.value.trim()) { clearTimeout(timer); timer = setTimeout(run, 300) } }, { deep: true })
watch(() => props.show, v => {
  clearTimeout(timer)
  if (v) { q.value = ''; results.value = []; searched.value = false; truncated.value = false; indexed.value = true }
})

function resetFilters() {
  const keep = { open: f.open, scope: f.scope }
  Object.assign(f, JSON.parse(JSON.stringify(DEFAULTS)), keep)
}

const rows = () => [...(list.value?.querySelectorAll('.row-btn') ?? [])]
function focusRow(i) {
  const all = rows()
  if (!all.length) return
  all[Math.max(0, Math.min(all.length - 1, i))].focus()
}
function onListKey(e) {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
  e.preventDefault()
  const i = rows().indexOf(document.activeElement)
  if (e.key === 'ArrowUp' && i <= 0) { input.value?.focus(); return }
  focusRow(i + (e.key === 'ArrowDown' ? 1 : -1))
}

function pick(r) {
  emit('select', r)
  emit('update:show', false)
}
</script>

<style scoped>
.bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 10px; }
.scope { font-size: 12px; margin-top: 6px; }
.filters { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px 12px; margin-top: 12px; padding: 12px; border: 1px solid var(--border); border-radius: 10px; background: var(--surface-2); }
.fld { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.fld.wide { grid-column: 1 / -1; }
.lbl { font-size: 12px; color: var(--muted); }
.pair { display: flex; gap: 6px; }
.pair .unit { width: 78px; flex: none; }
.note { margin-top: 10px; padding: 6px 10px; font-size: 12.5px; border-radius: 8px; background: var(--primary-soft); color: var(--text); }
.results { margin-top: 12px; max-height: 380px; overflow-y: auto; min-height: 100px; }
.row-btn { all: unset; box-sizing: border-box; display: flex; align-items: center; gap: 12px; width: 100%; padding: 8px 10px; border-radius: 8px; cursor: pointer; }
.row-btn:hover, .row-btn:focus-visible { background: var(--surface-2); outline: 2px solid var(--primary); outline-offset: -2px; }
.row-btn:hover { outline: none; }
.grow { min-width: 0; flex: 1; }
.wrap { overflow-wrap: anywhere; }
.nm { font-size: 14px; font-weight: 500; }
.p { font-size: 12px; }
.meta { display: flex; flex-wrap: wrap; gap: 0 12px; font-size: 12px; }
.none { padding: 20px; text-align: center; font-size: 14px; }
@media (max-width: 520px) { .filters { grid-template-columns: minmax(0, 1fr); } }
</style>
