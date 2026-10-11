<template>
  <div class="page narrow">
    <div class="page-header">
      <div><h1>{{ t('nav.update') }}</h1><p>{{ t('update.subtitle') }}</p></div>
      <n-button :loading="loading" :disabled="busy" @click="load"><template #icon><n-icon :component="RefreshOutline" /></template>{{ t('common.refresh') }}</n-button>
    </div>

    <n-spin :show="loading && !st">
      <template v-if="st">
        <div class="surface block">
          <div class="kv"><span class="muted">{{ t('update.current') }}</span><span class="strong">v{{ st.runningVersion }}</span></div>
          <div class="kv"><span class="muted">{{ t('update.source') }}</span><span>{{ st.runningRelease ? t('update.sourceUpdate') : t('update.sourceBuiltin') }}</span></div>
        </div>

        <n-alert v-if="st.pending" type="info" class="gap">{{ t('update.pending', { v: pendingVersion }) }}</n-alert>
        <n-alert v-if="st.last && st.last.ok" type="success" class="gap" closable>{{ t('update.lastOk', { v: st.last.version }) }}</n-alert>
        <n-alert v-if="st.last && !st.last.ok" type="error" class="gap">{{ t('update.lastFail', { v: st.last.version, msg: st.last.message }) }}</n-alert>
        <n-alert v-if="!st.enabled" type="warning" class="gap">{{ t('update.disabled') }}</n-alert>
        <n-alert v-else-if="!st.supervised" type="warning" class="gap">{{ t('update.notSupervised') }}</n-alert>

        <!-- restarting -->
        <div v-if="phase === 'installing'" class="surface block center">
          <n-spin size="large" />
          <h2>{{ t('update.installing') }}</h2>
          <p class="muted">{{ t('update.waiting') }}</p>
        </div>

        <!-- checked package waiting for the admin's go -->
        <div v-else-if="phase === 'ready' && staged" class="surface block">
          <h2>{{ t('update.ready') }}</h2>
          <div class="kv"><span class="muted">{{ t('update.newVersion') }}</span><span class="strong">v{{ staged.runningVersion }} → v{{ staged.version }}</span></div>
          <div class="kv"><span class="muted">{{ t('update.builtAt') }}</span><span>{{ staged.builtAt ? formatDate(staged.builtAt) : '-' }}</span></div>
          <div class="kv"><span class="muted">{{ t('update.files') }}</span><span>{{ staged.files }} · {{ formatBytes(staged.bytes) }}</span></div>
          <div v-if="staged.notes" class="kv"><span class="muted">{{ t('update.notes') }}</span><span class="notes">{{ staged.notes }}</span></div>
          <div class="kv"><span class="muted">SHA-256</span><span class="mono small">{{ staged.serverSha256.slice(0, 16) }}…</span></div>
          <n-alert type="success" class="gap top">{{ t('update.checked') }}</n-alert>
          <n-alert type="info" class="gap">{{ t('update.restartNote') }}</n-alert>
          <n-alert v-if="st.uploadsInProgress" type="warning" class="gap">{{ t('update.uploadsWarn', { n: st.uploadsInProgress }) }}</n-alert>
          <n-form label-placement="top" @submit.prevent="install">
            <n-form-item :label="t('update.password')">
              <n-input v-model:value="password" type="password" show-password-on="click" autocomplete="current-password" :input-props="{ name: 'confirm-password' }" @keyup.enter="install" />
            </n-form-item>
          </n-form>
          <div class="actions">
            <n-button @click="discard">{{ t('update.discard') }}</n-button>
            <n-button type="primary" :disabled="!password" :loading="working" @click="install"><template #icon><n-icon :component="CloudUploadOutline" /></template>{{ t('update.install') }}</n-button>
          </div>
        </div>

        <!-- drop zone -->
        <div v-else class="surface block">
          <n-upload :show-file-list="false" accept=".zip,application/zip" :disabled="!canUpdate || phase !== 'idle'" :custom-request="() => {}" :on-before-upload="onFile">
            <n-upload-dragger>
              <div class="drop">
                <n-icon size="44" :component="CloudUploadOutline" :depth="3" />
                <template v-if="phase === 'uploading'">
                  <div class="drop-title">{{ t('update.uploading', { pct: progress }) }}</div>
                  <n-progress type="line" :percentage="progress" :show-indicator="false" :height="8" style="max-width: 320px" />
                </template>
                <template v-else-if="phase === 'checking'">
                  <n-spin size="small" />
                  <div class="drop-title">{{ t('update.checking') }}</div>
                </template>
                <template v-else>
                  <div class="drop-title">{{ t('update.dropTitle') }}</div>
                  <div class="muted">{{ t('update.dropHint', { max: formatBytes(st.maxPackageSize) }) }}</div>
                </template>
              </div>
            </n-upload-dragger>
          </n-upload>
          <div class="muted howto"><strong>{{ t('update.how') }}:</strong> {{ t('update.howBody') }}</div>
        </div>

        <div class="surface block">
          <h2>{{ t('update.versions') }}</h2>
          <div v-if="!rollbackOptions.length" class="muted">{{ t('update.none') }}</div>
          <div v-for="o in rollbackOptions" :key="o.dir" class="kv">
            <span>
              <span class="strong">v{{ o.version }}</span>
              <span v-if="o.dir === 'builtin'" class="muted"> · {{ t('update.builtin') }}</span>
              <span v-else-if="o.builtAt" class="muted"> · {{ formatDate(o.builtAt) }}</span>
            </span>
            <n-button size="small" secondary :disabled="!canUpdate || busy" @click="askRollback(o)"><template #icon><n-icon :component="ArrowUndoOutline" /></template>{{ t('update.rollback') }}</n-button>
          </div>
        </div>
      </template>
    </n-spin>

    <n-modal v-model:show="rollbackOpen" preset="card" :title="t('update.rollbackTitle', { v: rollbackTarget?.version })" style="max-width: 440px" :mask-closable="!working">
      <p>{{ t('update.rollbackBody', { v: rollbackTarget?.version }) }}</p>
      <n-form label-placement="top" @submit.prevent="rollback">
        <n-form-item :label="t('update.password')">
          <n-input v-model:value="password" type="password" show-password-on="click" autocomplete="current-password" :input-props="{ name: 'confirm-password' }" @keyup.enter="rollback" />
        </n-form-item>
      </n-form>
      <div class="actions">
        <n-button :disabled="working" @click="rollbackOpen = false">{{ t('common.cancel') }}</n-button>
        <n-button type="primary" :disabled="!password" :loading="working" @click="rollback">{{ t('update.rollback') }}</n-button>
      </div>
    </n-modal>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { NAlert, NButton, NForm, NFormItem, NIcon, NInput, NModal, NProgress, NSpin, NUpload, NUploadDragger } from 'naive-ui'
import { ArrowUndoOutline, CloudUploadOutline, RefreshOutline } from '@vicons/ionicons5'
import { api, ApiError, putChunk } from '../api'
import { useFeedback } from '../composables'
import { bootId, sleep, waitForRestart } from '../restart'
import { formatBytes, formatDate } from '../utils'

const { t } = useI18n()
const fb = useFeedback()
const st = ref(null)
const loading = ref(false)
const working = ref(false)
// idle -> uploading -> checking -> ready -> installing (page reloads when done)
const phase = ref('idle')
const progress = ref(0)
const staged = ref(null)
const password = ref('')
const rollbackOpen = ref(false)
const rollbackTarget = ref(null)
let poll = null

const busy = computed(() => phase.value !== 'idle')
const canUpdate = computed(() => !!st.value?.enabled && !!st.value?.supervised)
const pendingVersion = computed(() => st.value?.pending?.dir.split('-')[0] ?? '')
const rollbackOptions = computed(() => {
  if (!st.value) return []
  const list = [...st.value.history.map(h => ({ dir: h.dir, version: h.version, builtAt: h.builtAt }))]
  if (st.value.runningRelease) list.push({ dir: 'builtin', version: st.value.builtinVersion, builtAt: '' })
  return list
})

async function load() {
  loading.value = true
  try { st.value = await api.updateStatus() } catch (e) { fb.fail(e) } finally { loading.value = false }
}

async function sendPackage(file) {
  const init = await api.updateInit(file.size)
  const sent = new Array(init.total).fill(0)
  for (let i = 0; i < init.total; i++) {
    const blob = file.slice(i * init.chunkSize, Math.min(file.size, (i + 1) * init.chunkSize))
    for (let attempt = 1; ; attempt++) {
      try {
        await putChunk(init.id, i, blob, loaded => {
          sent[i] = loaded
          progress.value = Math.min(99, Math.round((sent.reduce((a, b) => a + b, 0) / Math.max(1, file.size)) * 100))
        }, () => {})
        sent[i] = blob.size
        break
      } catch (e) {
        if (attempt >= 3 || !(e.status === 0 || e.status >= 500)) throw e
        await sleep(1000 * attempt)
      }
    }
  }
  return init.id
}

async function onFile({ file }) {
  if (!file.file || busy.value) return false
  progress.value = 0
  phase.value = 'uploading'
  try {
    const id = await sendPackage(file.file)
    progress.value = 100
    phase.value = 'checking'
    staged.value = await api.updateStage(id)
    password.value = ''
    await load()
    phase.value = 'ready'
  } catch (e) {
    phase.value = 'idle'
    fb.fail(e)
  }
  return false
}

async function discard() {
  const id = staged.value?.id
  staged.value = null
  phase.value = 'idle'
  password.value = ''
  if (id) { try { await api.updateDiscard(id) } catch { /* it is cleaned up later anyway */ } }
}

async function afterRestart(before, expectedVersion) {
  phase.value = 'installing'
  const h = await waitForRestart(before)
  if (!h) {
    phase.value = 'idle'
    fb.warn(t('update.timeout'))
  } else if (h.version === expectedVersion) {
    fb.ok(t('update.done', { v: h.version }))
    await sleep(800)
    location.reload()
  } else {
    phase.value = 'idle'
    staged.value = null
    await load()
    fb.warn(t('update.rolledBack', { v: h.version }))
  }
}

async function run(call, version) {
  working.value = true
  try {
    const before = await bootId()
    await call()
    password.value = ''
    rollbackOpen.value = false
    working.value = false
    await afterRestart(before, version)
  } catch (e) {
    fb.fail(e)
    if (e instanceof ApiError && e.status === 404) { staged.value = null; phase.value = 'idle' }
  } finally { working.value = false }
}

const install = () => password.value && run(() => api.updateApply(staged.value.id, password.value), staged.value.version)

function askRollback(option) {
  rollbackTarget.value = option
  password.value = ''
  rollbackOpen.value = true
}
const rollback = () => password.value && run(() => api.updateRollback(rollbackTarget.value.dir, password.value), rollbackTarget.value.version)

onMounted(() => { load(); poll = setInterval(() => { if (!busy.value && !rollbackOpen.value) load() }, 15_000) })
onBeforeUnmount(() => clearInterval(poll))
</script>

<style scoped>
.narrow { max-width: 760px; }
.block { padding: 22px; margin-bottom: 16px; }
.block h2 { margin: 0 0 12px; font-size: 16px; font-weight: 600; }
.gap { margin-bottom: 12px; }
.gap.top { margin-top: 14px; }
.kv { display: flex; justify-content: space-between; align-items: center; gap: 16px; padding: 9px 0; border-top: 1px solid var(--border); font-size: 14px; }
.kv:first-of-type { border-top: 0; }
.strong { font-weight: 600; }
.small { font-size: 12.5px; }
.notes { white-space: pre-wrap; text-align: right; max-width: 70%; }
.center { display: flex; flex-direction: column; align-items: center; text-align: center; padding: 40px 22px; }
.center h2 { margin-top: 18px; }
.drop { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 18px 8px; text-align: center; }
.drop-title { font-size: 15px; font-weight: 500; }
.howto { margin-top: 14px; font-size: 13px; }
.actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 8px; }
</style>
