<template>
  <div class="page">
    <div class="page-header">
      <div><h1>{{ t('nav.dashboard') }}</h1><p>{{ t('dash.subtitle') }}</p></div>
      <n-button :loading="loading" @click="load"><template #icon><n-icon :component="RefreshOutline" /></template>{{ t('common.refresh') }}</n-button>
    </div>

    <n-alert v-if="error" type="error" class="gap">{{ error }}</n-alert>
    <div v-if="s?.warnings?.length" class="warnings">
      <n-alert v-for="w in s.warnings" :key="w.code + w.message" :type="w.level === 'critical' ? 'error' : w.level === 'warning' ? 'warning' : 'info'" :show-icon="true">
        <span class="warn-row">
          <span>{{ w.message }}</span>
          <router-link v-if="w.code === 'errors'" :to="{ name: 'logs', query: { level: 'error' } }" class="warn-link">{{ t('dash.viewLogs') }} →</router-link>
        </span>
      </n-alert>
    </div>

    <n-spin :show="loading && !s">
      <div v-if="s" class="cards">
        <div class="surface card wide">
          <div class="label">{{ t('dash.disk') }}</div>
          <template v-if="s.disk">
            <div class="value">{{ formatBytes(s.disk.free) }} <span class="muted unit">{{ t('dash.free') }}</span></div>
            <n-progress type="line" :percentage="diskPct" :status="diskPct > 95 ? 'error' : diskPct > 90 ? 'warning' : 'success'" :show-indicator="false" :height="8" />
            <div class="muted note">{{ t('dash.diskUsed', { used: formatBytes(s.disk.used), total: formatBytes(s.disk.total), pct: diskPct }) }}</div>
          </template>
          <div v-else class="muted note">{{ t('dash.unknown') }}</div>
        </div>
        <!-- counted in the background: null until the first count ends, stale while a new count runs -->
        <div v-for="c in storageCards" :key="c.key" class="surface card">
          <div class="label">{{ c.label }}</div>
          <template v-if="c.files !== null">
            <div class="value">{{ c.files.toLocaleString() }}<span v-if="c.truncated">+</span></div>
            <div class="muted note">{{ formatBytes(c.size) }}<span v-if="c.truncated"> +</span></div>
            <div v-if="s.stale" class="muted note counting-note"><n-icon :component="SyncOutline" class="turning" /><span>{{ t('dash.counting') }}</span></div>
          </template>
          <div v-else class="value small counting"><n-icon :component="SyncOutline" class="turning" /><span>{{ t('dash.counting') }}</span></div>
          <div v-if="s.storage?.countedAt" class="muted small-note">{{ t('dash.countedAt', { time: formatDate(s.storage.countedAt) }) }}</div>
        </div>
        <div class="surface card">
          <div class="label">{{ t('dash.trash') }}</div>
          <div class="value">{{ s.trash.count }}</div>
          <div class="muted note">{{ formatBytes(s.trash.size) }}</div>
        </div>
        <div class="surface card">
          <div class="label">{{ t('dash.users') }}</div>
          <div class="value">{{ s.users }}</div>
          <div class="muted note">{{ t('dash.uploading', { n: s.uploadsInProgress }) }}</div>
        </div>
        <div class="surface card">
          <div class="label">{{ t('dash.backup') }}</div>
          <template v-if="s.backup">
            <div class="value small"><n-tag :type="s.backup.status === 'failed' ? 'error' : 'success'" size="small" round>{{ s.backup.status === 'failed' ? t('dash.backupFailed') : t('dash.backupOk') }}</n-tag></div>
            <div class="muted note">{{ s.backup.lastSuccess ? formatDate(s.backup.lastSuccess) : '-' }}</div>
          </template>
          <div v-else class="muted note">{{ t('dash.noBackup') }}</div>
        </div>
        <div class="surface card">
          <div class="label">{{ t('dash.system') }}</div>
          <div class="value small">v{{ s.version }}</div>
          <div class="muted note">{{ s.runtime }} · {{ t('dash.uptime', { time: formatDuration(s.uptimeSeconds) }) }}</div>
        </div>
      </div>
    </n-spin>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { NAlert, NButton, NIcon, NProgress, NSpin, NTag } from 'naive-ui'
import { RefreshOutline, SyncOutline } from '@vicons/ionicons5'
import { api } from '../api'
import { formatBytes, formatDate, formatDuration } from '../utils'

const { t, locale } = useI18n()
const s = ref(null)
const loading = ref(false)
const error = ref('')
let timer = null

const storageCards = computed(() => {
  const st = s.value?.storage
  return [
    { key: 'all', label: t('dash.files'), files: st?.files ?? null, size: st?.size ?? 0, truncated: !!st?.truncated },
    { key: 'public', label: t('dash.publicFiles'), files: st?.public?.files ?? null, size: st?.public?.size ?? 0, truncated: false },
  ]
})
const diskPct = computed(() => (s.value?.disk ? Math.round((s.value.disk.used / s.value.disk.total) * 100) : 0))

let recheck = null
let asked = 0
async function load() {
  // only the latest answer counts: one asked before a language switch may arrive after the one asked in the new language
  const mine = ++asked
  loading.value = true
  error.value = ''
  let next = s.value
  try { next = await api.status() } catch (e) { if (mine === asked) error.value = e.message }
  if (mine !== asked) return
  s.value = next
  loading.value = false
  // while the files are being counted, ask again soon rather than at the next 30 s round
  clearTimeout(recheck)
  if (s.value?.stale) recheck = setTimeout(load, 5000)
}
onMounted(() => { load(); timer = setInterval(load, 30_000) })
// the warnings (and any error) are written by the server in the page's language: ask again in the new one
watch(locale, () => load())
onBeforeUnmount(() => { clearInterval(timer); clearTimeout(recheck) })
</script>

<style scoped>
.gap { margin-bottom: 16px; }
.warnings { display: flex; flex-direction: column; gap: 8px; margin-bottom: 16px; }
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 16px; }
.card { padding: 18px; }
.card.wide { grid-column: span 2; }
.label { font-size: 13px; color: var(--muted); margin-bottom: 8px; }
.value { font-size: 28px; font-weight: 600; margin-bottom: 8px; line-height: 1.2; }
.value.small { font-size: 20px; }
.unit { font-size: 14px; font-weight: 400; }
.note { font-size: 13px; margin-top: 8px; }
.small-note { font-size: 12px; margin-top: 6px; }
.counting { display: flex; align-items: center; gap: 8px; color: var(--muted); }
.counting-note { display: flex; align-items: center; gap: 6px; margin-top: 4px; }
.turning { animation: turn 1.6s linear infinite; }
@keyframes turn { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .turning { animation: none; } }
.warn-row { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 12px; }
.warn-link { color: inherit; font-weight: 600; text-decoration: underline; text-underline-offset: 2px; white-space: nowrap; }
@media (max-width: 600px) { .card.wide { grid-column: auto; } }
</style>
