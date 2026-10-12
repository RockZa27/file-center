<template>
  <!-- ALERT_WEBHOOK_URL: whether it is on, where it goes (host only: the URL holds a token), when each kind last went out -->
  <div class="surface block">
    <div class="head">
      <h2>{{ t('alerts.title') }}</h2>
      <n-tag v-if="s" :type="s.enabled ? 'success' : 'default'" size="small" round :bordered="false">{{ s.enabled ? t('alerts.on') : t('alerts.off') }}</n-tag>
    </div>
    <n-alert v-if="loadError" type="error" class="gap refused">{{ loadError }}</n-alert>
    <n-spin :show="loading && !s">
      <template v-if="s">
        <template v-if="s.enabled">
          <div class="kv"><span class="muted">{{ t('alerts.kind') }}</span><span>{{ kindLabel(s.kind) }}</span></div>
          <div class="kv"><span class="muted">{{ t('alerts.host') }}</span><span class="mono small value">{{ s.host }}</span></div>
          <div class="sub muted">{{ t('alerts.lastSent') }}</div>
          <div v-for="k in KINDS" :key="k" class="kv">
            <span>{{ t(`alerts.kinds.${k}`) }}</span>
            <span v-if="s.lastSent[k]" class="value" :title="formatDate(s.lastSent[k])">{{ ago(s.lastSent[k]) }}</span>
            <span v-else class="muted value">{{ t('common.never') }}</span>
          </div>
          <n-alert v-if="result" :type="result.ok ? 'success' : 'error'" :title="result.ok ? undefined : t('alerts.testFailed')" class="gap top refused" closable @close="result = null">
            {{ result.ok ? t('alerts.testOk') : result.message }}
          </n-alert>
          <div class="actions">
            <n-button :loading="testing" @click="sendTest"><template #icon><n-icon :component="PaperPlaneOutline" /></template>{{ t('alerts.test') }}</n-button>
          </div>
        </template>
        <!-- set but refused (not https, unknown kind...): the server logged why at startup -->
        <n-alert v-else-if="s.host" type="warning" class="refused">
          {{ t('alerts.invalid', { host: s.host }) }}
          <router-link :to="{ name: 'logs', query: { level: 'warn' } }" class="link">{{ t('alerts.viewLog') }} →</router-link>
        </n-alert>
        <div v-else class="muted hint">{{ t('alerts.hint') }}</div>
      </template>
    </n-spin>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { NAlert, NButton, NIcon, NSpin, NTag } from 'naive-ui'
import { PaperPlaneOutline } from '@vicons/ionicons5'
import { api } from '../api'
import { errorText } from '../composables'
import { formatDate } from '../utils'

// the kinds alerts.ts sends, in the order the admin is likely to care
const KINDS = ['test', 'backup-failed', 'errors', 'lockout', 'disk-critical', 'update-available']
const WEBHOOKS = ['discord', 'slack', 'telegram', 'json']
const { t, locale } = useI18n()
const s = ref(null)
const loading = ref(false)
const loadError = ref('')
const testing = ref(false)
// the last test: { ok: true } or { ok: false, message } (the server's text)
const result = ref(null)
// "5 minutes ago" moves on by itself
const now = ref(Date.now())
let tick = null

const kindLabel = k => (WEBHOOKS.includes(k) ? t(`alerts.webhooks.${k}`) : k)
const rtf = computed(() => new Intl.RelativeTimeFormat(locale.value === 'th' ? 'th' : 'en', { numeric: 'auto' }))
function ago(iso) {
  const sec = Math.round((Date.parse(iso) - now.value) / 1000)
  const abs = Math.abs(sec)
  if (abs < 60) return rtf.value.format(Math.min(0, sec), 'second')
  if (abs < 3600) return rtf.value.format(Math.round(sec / 60), 'minute')
  if (abs < 86400) return rtf.value.format(Math.round(sec / 3600), 'hour')
  return rtf.value.format(Math.round(sec / 86400), 'day')
}

async function load() {
  loading.value = true
  try {
    s.value = await api.alerts()
    loadError.value = ''
  } catch (e) { loadError.value = errorText(e, t('common.unknownError')) } finally { loading.value = false }
}

async function sendTest() {
  testing.value = true
  result.value = null
  try {
    await api.alertTest()
    result.value = { ok: true }
  } catch (e) {
    result.value = { ok: false, message: errorText(e, t('common.unknownError')) }
  } finally {
    testing.value = false
    // the test counts as sent either way: show its time
    now.value = Date.now()
    load()
  }
}

// errors are written by the server in the old language: ask again for the status, drop a failed test's reason
watch(locale, () => {
  if (loadError.value) load()
  if (result.value && !result.value.ok) result.value = null
})
onMounted(() => { load(); tick = setInterval(() => { now.value = Date.now() }, 30_000) })
onBeforeUnmount(() => clearInterval(tick))
</script>

<style scoped>
.block { padding: 22px; margin-bottom: 16px; }
.head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
.head h2 { margin: 0; font-size: 16px; font-weight: 600; }
.kv { display: flex; justify-content: space-between; align-items: baseline; gap: 16px; padding: 8px 0; border-top: 1px solid var(--border); font-size: 14px; }
.kv:first-child { border-top: 0; }
.value { text-align: right; min-width: 0; overflow-wrap: anywhere; }
.small { font-size: 12.5px; }
.sub { font-size: 13px; margin: 14px 0 2px; }
.sub + .kv { border-top: 0; }
.gap { margin-bottom: 12px; }
.gap.top { margin-top: 12px; }
.refused { overflow-wrap: anywhere; }
.hint { font-size: 13.5px; line-height: 1.6; overflow-wrap: anywhere; }
.link { color: inherit; font-weight: 600; text-decoration: underline; text-underline-offset: 2px; white-space: nowrap; margin-left: 6px; }
.actions { display: flex; justify-content: flex-end; margin-top: 8px; }
</style>
