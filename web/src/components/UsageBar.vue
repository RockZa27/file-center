<template>
  <div class="ub">
    <n-progress v-if="quota > 0" type="line" :percentage="pct" :status="pct >= 95 ? 'error' : pct >= 80 ? 'warning' : 'success'" :show-indicator="false" :height="8" />
    <div class="txt muted" :class="{ full: quota > 0 && used >= quota }">
      {{ quota > 0 ? t('groups.usedOf', { used: formatBytes(used), quota: formatBytes(quota) }) : t('groups.usedOnly', { used: formatBytes(used) }) }}
      <template v-if="quota > 0 && used >= quota"> · {{ t('groups.full') }}</template>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { NProgress } from 'naive-ui'
import { formatBytes } from '../utils'

/** a storage bar for a group folder: `quota` 0 means no limit */
const props = defineProps({ used: { type: Number, default: 0 }, quota: { type: Number, default: 0 } })
const { t } = useI18n()
const pct = computed(() => Math.min(100, Math.round((props.used / props.quota) * 100)))
</script>

<style scoped>
.ub { min-width: 0; width: 100%; }
.txt { font-size: 12.5px; margin-top: 2px; overflow-wrap: anywhere; }
.full { color: var(--danger); }
</style>
