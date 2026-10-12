<template>
  <div class="csv-table">
    <div class="bar">
      <n-button size="small" secondary :disabled="readonly" @click="insertRow(rows.length)">
        <template #icon><n-icon :component="AddOutline" /></template>{{ t('editor.addRow') }}
      </n-button>
      <n-button size="small" secondary :disabled="readonly" @click="insertColumn(width)">
        <template #icon><n-icon :component="AddOutline" /></template>{{ t('editor.addColumn') }}
      </n-button>
      <span class="muted info">{{ t('editor.tableSize', { rows: rows.length.toLocaleString(), cols: width }) }} · {{ t('editor.delimiter', { d: delimiterName }) }}</span>
    </div>
    <div class="scroller">
      <table>
        <thead>
          <tr class="letters">
            <th class="num" />
            <th v-for="c in width" :key="c">
              <n-dropdown trigger="click" :options="columnOptions" :disabled="readonly" @select="k => onColumn(k, c - 1)">
                <button type="button" class="head-btn" :title="t('editor.columnMenu', { c: columnName(c - 1) })">{{ columnName(c - 1) }}<n-icon :component="ChevronDown" size="12" /></button>
              </n-dropdown>
            </th>
          </tr>
          <tr v-if="rows.length" class="first">
            <th class="num">
              <n-dropdown trigger="click" :options="rowOptions" :disabled="readonly" @select="k => onRow(k, 0)">
                <button type="button" class="head-btn" :title="t('editor.rowMenu', { n: 1 })">1</button>
              </n-dropdown>
            </th>
            <th v-for="c in width" :key="c">
              <textarea :value="rows[0][c - 1] ?? ''" rows="1" class="cell" :readonly="readonly" :aria-label="`${columnName(c - 1)}1`" @input="e => edit(0, c - 1, e.target.value)" />
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in pageRows" :key="r">
            <td class="num">
              <n-dropdown trigger="click" :options="rowOptions" :disabled="readonly" @select="k => onRow(k, r)">
                <button type="button" class="head-btn" :title="t('editor.rowMenu', { n: r + 1 })">{{ r + 1 }}</button>
              </n-dropdown>
            </td>
            <td v-for="c in width" :key="c">
              <textarea :value="rows[r][c - 1] ?? ''" rows="1" class="cell" :readonly="readonly" :aria-label="`${columnName(c - 1)}${r + 1}`" @input="e => edit(r, c - 1, e.target.value)" />
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <n-pagination v-if="pageCount > 1" v-model:page="page" :page-count="pageCount" size="small" :page-slot="narrow ? 5 : 9" class="pager" />
  </div>
</template>

<script setup>
import { computed, h, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { NButton, NDropdown, NIcon, NPagination } from 'naive-ui'
import { AddOutline, ChevronDown, TrashOutline } from '@vicons/ionicons5'
import { useNarrow } from '../composables'
import { columnName } from '../viewers/csv'

/**
 * A CSV file as a table to edit: cells, rows and columns added or removed. `rows` (string[][], all the same length)
 * is changed in place and `change` tells the editor; the first row stays on top as the header while scrolling.
 */
const props = defineProps({ rows: { type: Array, required: true }, delimiter: { type: String, default: ',' }, readonly: Boolean })
const emit = defineEmits(['change'])
const { t } = useI18n()
const narrow = useNarrow()

const PAGE = 100
const page = ref(1)
const version = ref(0)
const width = computed(() => (version.value, props.rows.reduce((m, r) => Math.max(m, r.length), 0)))
const pageCount = computed(() => (version.value, Math.max(1, Math.ceil((props.rows.length - 1) / PAGE))))
const pageRows = computed(() => {
  void version.value
  const from = 1 + (page.value - 1) * PAGE
  const to = Math.min(props.rows.length, from + PAGE)
  return Array.from({ length: Math.max(0, to - from) }, (_, i) => from + i)
})
watch(pageCount, n => { if (page.value > n) page.value = n })
watch(() => props.rows, () => { page.value = 1; version.value++ })

const delimiterName = computed(() => ({ ',': t('editor.comma'), ';': t('editor.semicolon'), '\t': t('editor.tab'), '|': '|' }[props.delimiter] ?? props.delimiter))

function changed() {
  version.value++
  emit('change')
}

function edit(r, c, value) {
  const row = props.rows[r]
  while (row.length <= c) row.push('')
  row[c] = value
  emit('change')
}

function insertRow(at) {
  props.rows.splice(at, 0, Array(width.value || 1).fill(''))
  changed()
  // show the page with the new row
  if (at > 0) page.value = Math.max(1, Math.ceil(at / PAGE))
}
function insertColumn(at) {
  if (!props.rows.length) props.rows.push([])
  for (const row of props.rows) {
    while (row.length < at) row.push('')
    row.splice(at, 0, '')
  }
  changed()
}

const ico = c => () => h(NIcon, { component: c })
const rowOptions = computed(() => [
  { key: 'above', label: t('editor.insertAbove') },
  { key: 'below', label: t('editor.insertBelow') },
  { type: 'divider', key: 'd' },
  { key: 'delete', label: t('editor.deleteRow'), icon: ico(TrashOutline) },
])
const columnOptions = computed(() => [
  { key: 'left', label: t('editor.insertLeft') },
  { key: 'right', label: t('editor.insertRight') },
  { type: 'divider', key: 'd' },
  { key: 'delete', label: t('editor.deleteColumn'), icon: ico(TrashOutline) },
])

function onRow(key, r) {
  if (key === 'above') return insertRow(r)
  if (key === 'below') return insertRow(r + 1)
  props.rows.splice(r, 1)
  changed()
}
function onColumn(key, c) {
  if (key === 'left') return insertColumn(c)
  if (key === 'right') return insertColumn(c + 1)
  for (const row of props.rows) row.splice(c, 1)
  // the last column gone: no empty rows of nothing left behind
  if (props.rows.every(r => r.length === 0)) props.rows.splice(0)
  changed()
}
</script>

<style scoped>
.bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
.info { font-size: 12.5px; }
.scroller { max-height: 58vh; overflow: auto; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); }
table { width: max-content; border-collapse: separate; border-spacing: 0; font-size: 13px; }
th, td { padding: 0; border-right: 1px solid var(--border); border-bottom: 1px solid var(--border); vertical-align: top; }
thead { position: sticky; top: 0; z-index: 2; }
thead th { background: var(--surface-2); }
.letters th { font-weight: 500; color: var(--muted); }
.first .cell { font-weight: 600; }
.num { position: sticky; left: 0; z-index: 1; background: var(--surface-2); min-width: 44px; }
thead .num { z-index: 3; }
.head-btn { all: unset; box-sizing: border-box; display: flex; align-items: center; justify-content: center; gap: 2px; width: 100%; padding: 4px 6px; cursor: pointer; font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }
.head-btn:hover, .head-btn:focus-visible { color: var(--primary); background: var(--primary-soft); }
.cell {
  display: block; box-sizing: border-box; width: 100%; min-width: 120px; max-width: min(320px, 70vw); min-height: 30px; margin: 0; padding: 5px 8px;
  border: 0; outline: 0; resize: none; background: transparent; color: var(--text); font: inherit; line-height: 1.45;
  white-space: pre-wrap; overflow-wrap: anywhere; field-sizing: content;
}
.cell:focus { background: var(--primary-soft); box-shadow: inset 0 0 0 2px var(--primary); }
.pager { margin-top: 8px; justify-content: center; }
</style>
