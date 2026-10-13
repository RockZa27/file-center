<template>
  <ul class="devices">
    <li v-for="s in sessions" :key="s.id" class="device">
      <div class="info">
        <div class="name">
          <span class="what">{{ label(s) }}</span>
          <n-tag v-if="s.current" size="small" type="success" round :bordered="false">{{ t('devices.thisDevice') }}</n-tag>
        </div>
        <div class="muted meta">
          <span class="mono">{{ s.ip }}</span>
          <span>{{ t('devices.lastUsed') }} {{ ago(s.seen) }}</span>
        </div>
      </div>
      <n-button v-if="removable" size="small" secondary :type="s.current ? 'warning' : 'default'" :loading="busyId === s.id" @click="emit('revoke', s)">
        {{ s.current ? t('nav.logout') : t('devices.signOut') }}
      </n-button>
    </li>
    <li v-if="!sessions.length" class="muted empty">{{ t('devices.none') }}</li>
  </ul>
</template>

<script setup>
import { onBeforeUnmount, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { NButton, NTag } from 'naive-ui'
import { describeUserAgent, relativeTime } from '../account-utils'

defineProps({ sessions: { type: Array, default: () => [] }, removable: Boolean, busyId: { type: String, default: '' } })
const emit = defineEmits(['revoke'])
const { t, locale } = useI18n()
const now = ref(Date.now())
const tick = setInterval(() => { now.value = Date.now() }, 30000)
onBeforeUnmount(() => clearInterval(tick))

const label = s => {
  const { browser, os } = describeUserAgent(s.ua)
  return [browser, os].filter(Boolean).join(' · ') || t('devices.unknown')
}
const ago = ms => relativeTime(ms, now.value, locale.value)
</script>

<style scoped>
.devices { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.device { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 10px 12px; border: 1px solid var(--border); border-radius: 10px; background: var(--surface-2); }
.info { min-width: 0; flex: 1; }
.name { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; font-weight: 600; }
.what { overflow-wrap: anywhere; }
.meta { display: flex; flex-wrap: wrap; gap: 2px 12px; font-size: 12.5px; margin-top: 2px; }
.meta span { overflow-wrap: anywhere; }
.empty { padding: 8px 0; }
@media (max-width: 420px) { .device { flex-direction: column; align-items: stretch; } .device :deep(.n-button) { align-self: flex-start; } }
</style>
