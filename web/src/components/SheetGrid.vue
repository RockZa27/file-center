<template>
  <div class="sheet-grid">
    <div v-if="!rows.length" class="muted empty">{{ t('preview.emptySheet') }}</div>
    <div v-else class="scroller">
      <table>
        <thead>
          <tr>
            <th class="num" />
            <th v-for="(v, c) in rows[0]" :key="c"><div class="v">{{ v }}</div></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(row, r) in body" :key="r">
            <td class="num">{{ r + 2 }}</td>
            <td v-for="(v, c) in row" :key="c" :class="{ number: isNumber(v) }"><div class="v">{{ v }}</div></td>
          </tr>
        </tbody>
      </table>
    </div>
    <div v-if="notes.length" class="notes muted">
      <div v-for="n in notes" :key="n">{{ n }}</div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

/** a read-only table: the first row stays on top while scrolling, row numbers on the left as in a spreadsheet */
const props = defineProps({
  rows: { type: Array, required: true },
  totalRows: { type: Number, default: 0 },
  totalCols: { type: Number, default: 0 },
})
const { t } = useI18n()

const body = computed(() => props.rows.slice(1))
const notes = computed(() => {
  const out = []
  const width = props.rows[0]?.length ?? 0
  if (props.totalRows > props.rows.length) out.push(t('preview.rowsCapped', { shown: props.rows.length.toLocaleString(), total: props.totalRows.toLocaleString() }))
  if (props.totalCols > width) out.push(t('preview.colsCapped', { shown: width.toLocaleString(), total: props.totalCols.toLocaleString() }))
  return out
})
const isNumber = v => /^[-+(]?[฿$€£¥]?\d[\d,]*(\.\d+)?%?\)?$/.test(v)
</script>

<style scoped>
.scroller { max-height: 62vh; overflow: auto; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); }
/* as wide as the content, each column at most 320 px: long text wraps inside its cell instead of squeezing the others */
table { width: max-content; border-collapse: separate; border-spacing: 0; font-size: 13px; }
th, td { padding: 5px 10px; border-right: 1px solid var(--border); border-bottom: 1px solid var(--border); text-align: left; vertical-align: top; }
.v { max-width: min(320px, 70vw); min-width: 2.5em; white-space: pre-wrap; overflow-wrap: anywhere; }
thead th { position: sticky; top: 0; z-index: 1; background: var(--surface-2); font-weight: 600; }
.num { position: sticky; left: 0; min-width: 0; color: var(--muted); background: var(--surface-2); text-align: right; font-variant-numeric: tabular-nums; }
thead .num { z-index: 2; }
td.number { text-align: right; font-variant-numeric: tabular-nums; }
td.number .v { white-space: nowrap; }
.empty { padding: 32px; text-align: center; }
.notes { font-size: 12.5px; margin-top: 8px; }
</style>
