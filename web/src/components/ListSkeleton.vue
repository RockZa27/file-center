<template>
  <div class="sk" role="status" aria-busy="true" :aria-label="t('ux.loading')">
    <div v-for="i in rows" :key="i" class="sk-row">
      <n-skeleton v-if="icon" :width="26" :height="26" :sharp="false" />
      <div class="sk-text">
        <n-skeleton text :style="{ width: `${72 - (i % 3) * 14}%` }" />
        <n-skeleton v-if="!compact" text :style="{ width: `${38 - (i % 2) * 8}%` }" />
      </div>
    </div>
  </div>
</template>

<script setup>
// What a list shows while it is read for the first time (a reload keeps the old rows and the refresh button spins).
import { useI18n } from 'vue-i18n'
import { NSkeleton } from 'naive-ui'

defineProps({
  rows: { type: Number, default: 5 },
  /** a square at the left of each row, where the list has an icon */
  icon: { type: Boolean, default: true },
  /** one line per row instead of two */
  compact: { type: Boolean, default: false },
})
const { t } = useI18n()
</script>

<style scoped>
.sk-row { display: flex; align-items: center; gap: 14px; padding: 14px 16px; border-bottom: 1px solid var(--border); }
.sk-row:last-child { border-bottom: 0; }
.sk-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
</style>
