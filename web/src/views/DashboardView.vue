<template>
  <div class="page">
    <div class="page-header">
      <div><h1>{{ t('nav.dashboard') }}</h1><p>{{ t('dash.subtitle') }}</p></div>
      <n-button :loading="loading" @click="load"><template #icon><n-icon :component="RefreshOutline" /></template>{{ t('common.refresh') }}</n-button>
    </div>

    <n-alert v-if="error" type="error" class="gap">{{ error }}</n-alert>
    <div v-if="s?.warnings?.length" class="warnings">
      <n-alert v-for="w in s.warnings" :key="w.code + w.message" :type="w.level === 'critical' ? 'error' : w.level === 'warning' ? 'warning' : 'info'" :show-icon="true">{{ w.message }}</n-alert>
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
        <div class="surface card">
          <div class="label">{{ t('dash.files') }}</div>
          <div class="value">{{ s.storage.files.toLocaleString() }}</div>
          <div class="muted note">{{ formatBytes(s.storage.size) }}<span v-if="s.storage.truncated"> +</span></div>
        </div>
        <div class="surface card">
          <div class="label">{{ t('dash.publicFiles') }}</div>
          <div class="value">{{ s.storage.public.files.toLocaleString() }}</div>
          <div class="muted note">{{ formatBytes(s.storage.public.size) }}</div>
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
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { NAlert, NButton, NIcon, NProgress, NSpin, NTag } from 'naive-ui'
import { RefreshOutline } from '@vicons/ionicons5'
import { api } from '../api'
import { formatBytes, formatDate, formatDuration } from '../utils'

const { t } = useI18n()
const s = ref(null)
const loading = ref(false)
const error = ref('')
let timer = null

const diskPct = computed(() => (s.value?.disk ? Math.round((s.value.disk.used / s.value.disk.total) * 100) : 0))

async function load() {
  loading.value = true
  error.value = ''
  try { s.value = await api.status() } catch (e) { error.value = e.message } finally { loading.value = false }
}
onMounted(() => { load(); timer = setInterval(load, 30_000) })
onBeforeUnmount(() => clearInterval(timer))
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
@media (max-width: 600px) { .card.wide { grid-column: auto; } }
</style>
