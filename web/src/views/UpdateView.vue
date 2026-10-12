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
          <div class="kv">
            <span class="muted label">{{ t('update.signing') }}</span>
            <span class="badge" :class="{ on: st.signatureRequired }">
              <n-icon :component="st.signatureRequired ? ShieldCheckmarkOutline : ShieldOutline" /><span>{{ st.signatureRequired ? t('update.signingRequired') : t('update.signingOptional') }}</span>
            </span>
          </div>
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
          <div class="kv">
            <span class="muted">{{ t('update.signature') }}</span>
            <n-tag v-if="staged.signed" :type="staged.signatureVerified ? 'success' : 'info'" :bordered="false" class="sig">
              <template #icon><n-icon :component="staged.signatureVerified ? ShieldCheckmarkOutline : ShieldOutline" /></template>
              {{ staged.signatureVerified ? t('update.signedVerified') : t('update.signedUnchecked') }}
            </n-tag>
            <n-tag v-else type="warning" :bordered="false" class="sig"><template #icon><n-icon :component="WarningOutline" /></template>{{ t('update.unsigned') }}</n-tag>
          </div>
          <div v-if="staged.fromWeb" class="kv"><span class="muted">{{ t('update.source') }}</span><span class="mono small url">{{ t('update.fromWeb', { url: staged.fromWeb }) }}</span></div>
          <n-alert v-if="!staged.signed && staged.fromWeb" type="error" :title="t('update.unsignedWebTitle')" class="gap top">{{ t('update.unsignedWebBody') }}</n-alert>
          <n-alert v-else-if="!staged.signed" type="warning" class="gap top">{{ t('update.unsignedBody') }}</n-alert>
          <n-alert type="success" class="gap" :class="{ top: staged.signed }">{{ t('update.checked') }}</n-alert>
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

        <!-- a newer version published at UPDATE_SOURCE: asked only when the admin presses the button -->
        <div v-if="st.source?.enabled && (phase === 'idle' || phase === 'fetching')" class="surface block">
          <h2>{{ t('update.web') }}</h2>
          <div class="kv"><span class="muted label">{{ t('update.webFrom') }}</span><span class="mono small url">{{ st.source.url }}</span></div>
          <template v-if="check">
            <div class="kv"><span class="muted">{{ t('update.current') }}</span><span class="strong">v{{ check.current }}</span></div>
            <div class="kv"><span class="muted">{{ t('update.latest') }}</span><span class="strong">v{{ check.latest.version }}</span></div>
            <div v-if="check.latest.builtAt" class="kv"><span class="muted">{{ t('update.builtAt') }}</span><span>{{ formatDate(check.latest.builtAt) }}</span></div>
            <div class="kv"><span class="muted">{{ t('update.size') }}</span><span>{{ formatBytes(check.latest.size) }}</span></div>
            <div class="kv">
              <span class="muted">{{ t('update.signature') }}</span>
              <n-tag v-if="check.latest.signed" type="success" :bordered="false" class="sig"><template #icon><n-icon :component="ShieldCheckmarkOutline" /></template>{{ t('update.latestSigned') }}</n-tag>
              <n-tag v-else type="warning" :bordered="false" class="sig"><template #icon><n-icon :component="WarningOutline" /></template>{{ t('update.latestUnsigned') }}</n-tag>
            </div>
            <div v-if="check.latest.notes" class="kv"><span class="muted">{{ t('update.notes') }}</span><span class="notes">{{ check.latest.notes }}</span></div>
            <n-alert v-if="check.newer" type="info" class="gap top">{{ t('update.newer', { v: check.latest.version }) }}</n-alert>
            <n-alert v-else type="success" class="gap top">{{ t('update.upToDate', { v: check.current }) }}</n-alert>
          </template>
          <!-- stays until the next try: unreachable, not newer, checksum mismatch... -->
          <n-alert v-if="sourceError" type="error" :title="sourceError.title" closable class="gap top refused" @close="sourceError = null">{{ sourceError.message }}</n-alert>
          <div v-if="phase === 'fetching'" class="fetching"><n-spin size="small" /><span>{{ t('update.fetching') }}</span></div>
          <div class="actions">
            <n-button :loading="checking" :disabled="busy" @click="checkSource"><template #icon><n-icon :component="SearchOutline" /></template>{{ t('update.check') }}</n-button>
            <n-button v-if="check?.newer" type="primary" :loading="phase === 'fetching'" :disabled="!canUpdate || (busy && phase !== 'fetching')" @click="fetchPackage">
              <template #icon><n-icon :component="CloudDownloadOutline" /></template>{{ t('update.fetch') }}
            </n-button>
          </div>
        </div>

        <!-- drop zone -->
        <div v-if="phase !== 'installing' && !(phase === 'ready' && staged)" class="surface block">
          <!-- stays until the next package is dropped: a toast is gone before a long message is read -->
          <n-alert v-if="refused" type="error" :title="t('update.refused', { name: refused.name })" closable class="gap refused" @close="refused = null">{{ refused.message }}</n-alert>
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
import { NAlert, NButton, NForm, NFormItem, NIcon, NInput, NModal, NProgress, NSpin, NTag, NUpload, NUploadDragger } from 'naive-ui'
import {
  ArrowUndoOutline, CloudDownloadOutline, CloudUploadOutline, RefreshOutline, SearchOutline, ShieldCheckmarkOutline, ShieldOutline, WarningOutline,
} from '@vicons/ionicons5'
import { api, ApiError, putChunk } from '../api'
import { errorText, useFeedback } from '../composables'
import { bootId, sleep, waitForRestart } from '../restart'
import { formatBytes, formatDate } from '../utils'

const { t } = useI18n()
const fb = useFeedback()
const st = ref(null)
const loading = ref(false)
const working = ref(false)
// idle -> uploading -> checking -> ready -> installing (page reloads when done); idle -> fetching -> ready from UPDATE_SOURCE
const phase = ref('idle')
const progress = ref(0)
const staged = ref(null)
// why the last dropped package was refused ({ name, message }), until the next one
const refused = ref(null)
const password = ref('')
const rollbackOpen = ref(false)
const rollbackTarget = ref(null)
// the answer of "check for updates" ({ current, latest, newer }), and why checking or fetching failed ({ title, message })
const check = ref(null)
const checking = ref(false)
const sourceError = ref(null)
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
  refused.value = null
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
    refused.value = { name: file.name, message: errorText(e, t('common.unknownError')) }
  }
  return false
}

async function checkSource() {
  checking.value = true
  sourceError.value = null
  try {
    const r = await api.updateCheck()
    check.value = r.latest ? r : null
  } catch (e) {
    check.value = null
    sourceError.value = { title: t('update.checkFailed'), message: errorText(e, t('common.unknownError')) }
  } finally { checking.value = false }
}

// the server downloads and checks the package; its answer is the same as after an upload, so the same next step
async function fetchPackage() {
  if (busy.value) return
  sourceError.value = null
  refused.value = null
  phase.value = 'fetching'
  try {
    const from = st.value?.source?.url || ''
    staged.value = { ...(await api.updateFetch()), fromWeb: from }
    password.value = ''
    check.value = null
    await load()
    phase.value = 'ready'
  } catch (e) {
    phase.value = 'idle'
    sourceError.value = { title: t('update.fetchFailed'), message: errorText(e, t('common.unknownError')) }
  }
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
.refused { overflow-wrap: anywhere; }
.url { overflow-wrap: anywhere; text-align: right; min-width: 0; }
.fetching { display: flex; align-items: center; gap: 10px; margin-top: 12px; font-size: 14px; }
.kv { display: flex; justify-content: space-between; align-items: center; gap: 16px; padding: 9px 0; border-top: 1px solid var(--border); font-size: 14px; }
.kv:first-of-type { border-top: 0; }
.strong { font-weight: 600; }
.small { font-size: 12.5px; }
.notes { white-space: pre-wrap; text-align: right; max-width: 70%; }
.center { display: flex; flex-direction: column; align-items: center; text-align: center; padding: 40px 22px; }
.center h2 { margin-top: 18px; }
.drop { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 18px 8px; text-align: center; }
.drop-title { font-size: 15px; font-weight: 500; }
.howto { margin-top: 14px; font-size: 13px; overflow-wrap: anywhere; }
.actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 8px; }
.label { flex: none; }
.badge { display: inline-flex; align-items: flex-start; gap: 6px; text-align: right; }
.badge .n-icon { flex: none; font-size: 16px; margin-top: 2px; }
.badge.on { color: var(--primary); font-weight: 500; }
/* a tag stays on one line by default: let long labels wrap at 375 px */
.sig { height: auto; min-height: 24px; padding-top: 2px; padding-bottom: 2px; white-space: normal; text-align: left; }
</style>
