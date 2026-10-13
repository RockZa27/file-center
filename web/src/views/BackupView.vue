<template>
  <div class="page narrow">
    <div class="page-header">
      <div><h1>{{ t('nav.backup') }}</h1><p>{{ t('backup.subtitle') }}</p></div>
      <div class="head-actions">
        <n-button :loading="loading" :disabled="restoring" @click="load"><template #icon><n-icon :component="RefreshOutline" /></template>{{ t('common.refresh') }}</n-button>
        <n-button type="primary" :loading="creating" :disabled="restoring || working" @click="backupNow"><template #icon><n-icon :component="ArchiveOutline" /></template>{{ t('backup.now') }}</n-button>
      </div>
    </div>

    <!-- restarting after a restore -->
    <div v-if="restoring" class="surface block center">
      <n-spin size="large" />
      <h2>{{ t('backup.restoring') }}</h2>
      <p class="muted">{{ t('backup.waiting') }}</p>
    </div>

    <n-spin v-else :show="loading && !data">
      <template v-if="data">
        <n-alert v-if="settings.sameDisk" type="warning" :title="t('backup.sameDiskTitle')" class="gap">{{ t('backup.sameDisk') }}</n-alert>

        <div class="surface block">
          <h2>{{ t('backup.status') }}</h2>
          <div class="kv">
            <span class="muted">{{ t('backup.lastSuccess') }}</span>
            <span class="strong">{{ status?.lastSuccess ? formatDate(status.lastSuccess) : t('common.never') }}</span>
          </div>
          <div class="kv">
            <span class="muted">{{ t('backup.lastAttempt') }}</span>
            <span v-if="status" class="val">
              <n-tag :type="status.status === 'failed' ? 'error' : 'success'" size="small" round :bordered="false">{{ status.status === 'failed' ? t('backup.failed') : t('backup.ok') }}</n-tag>
              <span class="muted">{{ formatDate(status.lastAttempt) }}</span>
            </span>
            <span v-else>{{ t('common.never') }}</span>
          </div>
          <n-alert v-if="status?.status === 'failed'" type="error" class="gap top">{{ status.message }}</n-alert>
          <div class="kv">
            <span class="muted">{{ t('backup.schedule') }}</span>
            <span class="val">{{ settings.hour === null ? t('backup.off') : t('backup.daily', { time: `${String(settings.hour).padStart(2, '0')}:00` }) }}</span>
          </div>
          <div class="kv">
            <span class="muted">{{ t('backup.dir') }}</span>
            <span class="mono path">{{ settings.dir }}</span>
          </div>
          <div class="kv">
            <span class="muted">{{ t('backup.keep') }}</span>
            <span class="val">{{ t('backup.keepN', { n: settings.keep }) }}</span>
          </div>
          <div class="kv">
            <span class="muted">{{ t('backup.files') }}</span>
            <span class="val">{{ settings.includesFiles ? t('backup.filesIn') : t('backup.filesOut') }}</span>
          </div>
        </div>

        <div class="surface block">
          <h2>{{ t('backup.list') }}</h2>
          <n-empty v-if="!items.length" :description="t('backup.none')" class="empty" />
          <div v-for="b in items" :key="b.name" class="item">
            <div class="info">
              <div class="strong">{{ formatDate(b.createdAt) }}</div>
              <div class="muted small"><span class="mono name">{{ b.name }}</span> · {{ formatBytes(b.size) }}</div>
            </div>
            <div class="item-actions">
              <n-button
                tag="a" :href="api.backupUrl(b.name)" :download="b.name" size="small" secondary :loading="saving === b.name"
                @click="e => follow(e, api.backupUrl(b.name), { key: b.name, name: b.name, admin: true })"
              >
                <template #icon><n-icon :component="DownloadOutline" /></template>{{ t('common.download') }}
              </n-button>
              <n-button size="small" secondary :disabled="working || creating" @click="askRestore(b)">
                <template #icon><n-icon :component="ArrowUndoOutline" /></template>{{ t('backup.restore') }}
              </n-button>
              <n-button size="small" quaternary type="error" :disabled="working || creating" :aria-label="t('common.delete')" @click="remove(b)">
                <template #icon><n-icon :component="TrashOutline" /></template>
              </n-button>
            </div>
          </div>
        </div>
      </template>
    </n-spin>

    <n-modal v-model:show="restoreOpen" preset="card" :title="t('backup.restoreTitle', { date: target ? formatDate(target.createdAt) : '' })" style="width: calc(100vw - 32px); max-width: 480px" :mask-closable="!working" :closable="!working">
      <p class="intro">{{ t('backup.restoreIntro') }}</p>
      <ul class="replaced">
        <li>{{ t('backup.restoreUsers') }}</li>
        <li>{{ t('backup.restoreSettings') }}</li>
        <li>{{ t('backup.restoreLogo') }}</li>
      </ul>
      <n-alert type="success" class="gap">{{ t('backup.restoreNotFiles') }}</n-alert>
      <n-alert type="info" class="gap">{{ t('backup.restoreSafety') }}</n-alert>
      <n-alert type="warning" class="gap">{{ t('backup.restoreRestart') }}</n-alert>
      <n-form label-placement="top" @submit.prevent="restore">
        <n-form-item :label="t('backup.password')">
          <n-input :placeholder="t('backup.password')" v-model:value="password" type="password" show-password-on="click" autocomplete="current-password" :input-props="{ name: 'confirm-password' }" @keyup.enter="restore" />
        </n-form-item>
      </n-form>
      <div class="actions">
        <n-button :disabled="working" @click="restoreOpen = false">{{ t('common.cancel') }}</n-button>
        <n-button type="error" :disabled="!password" :loading="working" @click="restore"><template #icon><n-icon :component="ArrowUndoOutline" /></template>{{ t('backup.restoreGo') }}</n-button>
      </div>
    </n-modal>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { NAlert, NButton, NEmpty, NForm, NFormItem, NIcon, NInput, NModal, NSpin, NTag } from 'naive-ui'
import { ArchiveOutline, ArrowUndoOutline, DownloadOutline, RefreshOutline, TrashOutline } from '@vicons/ionicons5'
import { api } from '../api'
import { useDownload, useFeedback } from '../composables'
import { bootId, sleep, waitForRestart } from '../restart'
import { formatBytes, formatDate } from '../utils'

const { t } = useI18n()
const fb = useFeedback()
const { busy: saving, follow } = useDownload()
const data = ref(null)
const loading = ref(false)
const creating = ref(false)
const working = ref(false)
const restoring = ref(false)
const restoreOpen = ref(false)
const target = ref(null)
const password = ref('')

const items = computed(() => data.value?.items ?? [])
const status = computed(() => data.value?.status ?? null)
const settings = computed(() => data.value?.settings ?? {})

async function load() {
  loading.value = true
  try { data.value = await api.backups() } catch (e) { fb.fail(e) } finally { loading.value = false }
}

async function backupNow() {
  creating.value = true
  try {
    const item = await api.backupNow()
    fb.ok(t('backup.created', { size: formatBytes(item.size) }))
  } catch (e) { fb.fail(e) } finally {
    creating.value = false
    // a failed attempt is recorded in the status too
    await load()
  }
}

async function remove(b) {
  const yes = await fb.confirm({ title: t('backup.deleteTitle'), content: t('backup.deleteBody', { name: b.name }), positive: t('common.delete'), danger: true })
  if (!yes) return
  try {
    await api.backupDelete(b.name)
    fb.ok(t('backup.deleted'))
  } catch (e) { fb.fail(e) }
  await load()
}

function askRestore(b) {
  target.value = b
  password.value = ''
  restoreOpen.value = true
}

async function restore() {
  if (!password.value || working.value) return
  working.value = true
  try {
    const before = await bootId()
    await api.backupRestore(target.value.name, password.value)
    password.value = ''
    restoreOpen.value = false
    working.value = false
    restoring.value = true
    const h = await waitForRestart(before)
    if (h) {
      fb.ok(t('backup.done'))
      await sleep(800)
      location.reload()
    } else {
      restoring.value = false
      fb.warn(t('backup.timeout'))
      await load()
    }
  } catch (e) { fb.fail(e) } finally { working.value = false }
}

onMounted(load)
</script>

<style scoped>
.narrow { max-width: 760px; }
.head-actions { display: flex; gap: 10px; flex-wrap: wrap; }
.block { padding: 22px; margin-bottom: 16px; }
.block h2 { margin: 0 0 12px; font-size: 16px; font-weight: 600; }
.gap { margin-bottom: 12px; }
.gap.top { margin-top: 4px; }
.kv { display: flex; justify-content: space-between; align-items: center; gap: 16px; padding: 9px 0; border-top: 1px solid var(--border); font-size: 14px; }
.kv:first-of-type { border-top: 0; }
.kv > .muted { flex-shrink: 0; }
.val { display: inline-flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: flex-end; text-align: right; min-width: 0; }
.path { text-align: right; overflow-wrap: anywhere; min-width: 0; }
.strong { font-weight: 600; }
.small { font-size: 12.5px; }
.center { display: flex; flex-direction: column; align-items: center; text-align: center; padding: 40px 22px; }
.center h2 { margin-top: 18px; }
.empty { padding: 18px 0; }
.item { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 0; border-top: 1px solid var(--border); }
.item:first-of-type { border-top: 0; }
.info { min-width: 0; }
.name { overflow-wrap: anywhere; }
.item-actions { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
.intro { margin: 0 0 6px; }
.replaced { margin: 0 0 14px; padding-left: 20px; line-height: 1.7; }
.actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 8px; flex-wrap: wrap; }
@media (max-width: 600px) {
  .block { padding: 16px; }
  .kv { flex-wrap: wrap; gap: 4px 16px; }
  .path, .val { text-align: left; justify-content: flex-start; }
  .item { flex-wrap: wrap; }
  .item-actions { width: 100%; }
}
</style>
