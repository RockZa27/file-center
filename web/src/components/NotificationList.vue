<template>
  <div class="nl">
    <div class="head">
      <strong>{{ t('notify.title') }}</strong>
      <n-button text size="small" type="primary" :disabled="!unread" @click="emit('read-all')">{{ t('notify.markAll') }}</n-button>
    </div>
    <div v-if="!items.length" class="empty muted">
      <n-icon :component="NotificationsOffOutline" size="30" />
      <div>{{ t('notify.empty') }}</div>
    </div>
    <ul v-else class="list">
      <li v-for="n in items" :key="n.id" class="row" :class="{ unread: !n.read }">
        <button type="button" class="body" @click="emit('open', n)">
          <span class="dot" :class="{ on: !n.read }" :title="n.read ? '' : t('notify.unreadDot')" />
          <span class="txt">
            <span class="text">{{ n.text }}</span>
            <span class="when muted" :title="formatDate(n.at)">{{ ago(n.at) }}</span>
          </span>
        </button>
        <n-button quaternary circle size="tiny" class="del" :aria-label="t('notify.delete')" :title="t('notify.delete')" @click="emit('remove', n)">
          <template #icon><n-icon :component="CloseOutline" /></template>
        </n-button>
      </li>
    </ul>
    <div class="foot"><n-button text size="small" @click="emit('settings')">{{ t('notify.settings') }}</n-button></div>
  </div>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import { NButton, NIcon } from 'naive-ui'
import { CloseOutline, NotificationsOffOutline } from '@vicons/ionicons5'
import { formatDate } from '../utils'

defineProps({ items: { type: Array, default: () => [] }, unread: { type: Number, default: 0 } })
const emit = defineEmits(['open', 'remove', 'read-all', 'settings'])
const { t, locale } = useI18n()

const UNITS = [['day', 86400], ['hour', 3600], ['minute', 60]]
/** "5 minutes ago" in the page language */
function ago(at) {
  const secs = Math.round((new Date(at).getTime() - Date.now()) / 1000)
  if (Number.isNaN(secs)) return ''
  if (Math.abs(secs) < 45) return t('notify.justNow')
  const rtf = new Intl.RelativeTimeFormat(locale.value, { numeric: 'auto' })
  for (const [unit, size] of UNITS) if (Math.abs(secs) >= size) return rtf.format(Math.round(secs / size), unit)
  return t('notify.justNow')
}
</script>

<style scoped>
.nl { display: flex; flex-direction: column; min-height: 0; max-height: inherit; }
.head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 14px; border-bottom: 1px solid var(--border); }
.empty { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 36px 16px; text-align: center; }
.list { list-style: none; margin: 0; padding: 0; overflow-y: auto; flex: 1; min-height: 0; }
.row { display: flex; align-items: flex-start; gap: 4px; padding-right: 8px; border-bottom: 1px solid var(--border); }
.row.unread { background: var(--primary-soft); }
.body { all: unset; box-sizing: border-box; flex: 1; min-width: 0; display: flex; gap: 10px; padding: 11px 6px 11px 14px; cursor: pointer; }
.body:focus-visible { outline: 2px solid var(--primary); outline-offset: -2px; }
.dot { flex: 0 0 8px; height: 8px; margin-top: 7px; border-radius: 50%; background: transparent; }
.dot.on { background: var(--primary); }
.txt { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.text { font-size: 14px; line-height: 1.45; overflow-wrap: anywhere; }
.when { font-size: 12px; }
.del { margin-top: 8px; flex-shrink: 0; }
.foot { padding: 10px 14px; text-align: center; border-top: 1px solid var(--border); }
</style>
