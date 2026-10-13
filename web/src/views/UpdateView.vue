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
              <n-icon :component="st.signatureRequired ? ShieldCheckmarkOutline : ShieldOutline" /><span>{{ st.signatureRequired ? t('update.signingRequired') : t('update.signingAllowUnsigned') }}</span>
            </span>
          </div>
        </div>

        <n-alert v-if="st.allowUnsigned" type="warning" class="gap">{{ t('update.allowUnsignedBody') }}</n-alert>
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
          <n-alert v-if="!staged.signed" type="warning" class="gap top">{{ t('update.unsignedBody') }}</n-alert>
          <n-alert type="success" class="gap" :class="{ top: staged.signed }">{{ t('update.checked') }}</n-alert>
          <n-alert type="info" class="gap">{{ t('update.restartNote') }}</n-alert>
          <n-alert v-if="st.uploadsInProgress" type="warning" class="gap">{{ t('update.uploadsWarn', { n: st.uploadsInProgress }) }}</n-alert>
          <n-form label-placement="top" @submit.prevent="install">
            <n-form-item :label="t('update.password')">
              <n-input :placeholder="t('update.password')" v-model:value="password" type="password" show-password-on="click" autocomplete="current-password" :input-props="{ name: 'confirm-password' }" @keyup.enter="install" />
            </n-form-item>
          </n-form>
          <div class="actions">
            <n-button @click="discard">{{ t('update.discard') }}</n-button>
            <n-button type="primary" :disabled="!password" :loading="working" @click="install"><template #icon><n-icon :component="CloudUploadOutline" /></template>{{ t('update.install') }}</n-button>
          </div>
        </div>

        <!-- a newer version published at UPDATE_SOURCE: asked only when the admin presses the button -->
        <div v-if="st.source?.enabled && phase === 'idle'" class="surface block">
          <h2>{{ t('update.web') }}</h2>
          <div class="kv"><span class="muted label">{{ t('update.webFrom') }}</span><span class="mono small url">{{ st.source.url }}</span></div>
          <n-alert v-if="check && !check.newer" type="success" class="gap top">{{ t('update.latestAlready') }} (v{{ check.current }})</n-alert>
          <n-alert v-else-if="check?.newer" type="info" class="gap top">{{ t('update.newer', { v: check.latest.version }) }}</n-alert>
          <!-- stays until the next try: unreachable, latest.json broken... -->
          <n-alert v-if="checkError" type="error" :title="t('update.checkFailed')" closable class="gap top refused" @close="checkError = ''">{{ checkError }}</n-alert>
          <div class="actions">
            <n-button type="primary" :loading="checking" :disabled="!canUpdate || busy" @click="checkAndUpdate">
              <template #icon><n-icon :component="CloudDownloadOutline" /></template>{{ t('update.checkAndUpdate') }}
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
          <n-input :placeholder="t('update.password')" v-model:value="password" type="password" show-password-on="click" autocomplete="current-password" :input-props="{ name: 'confirm-password' }" @keyup.enter="rollback" />
        </n-form-item>
      </n-form>
      <div class="actions">
        <n-button :disabled="working" @click="rollbackOpen = false">{{ t('common.cancel') }}</n-button>
        <n-button type="primary" :disabled="!password" :loading="working" @click="rollback">{{ t('update.rollback') }}</n-button>
      </div>
    </n-modal>

    <!-- "check and update": what will be installed, the password, then the steps while the server works -->
    <n-modal v-model:show="oneOpen" preset="card" :title="t('update.oneTitle')" style="max-width: 520px" :closable="!oneRunning" :mask-closable="!oneRunning" :close-on-esc="!oneRunning">
      <template v-if="check?.latest">
        <div class="kv"><span class="muted">{{ t('update.newVersion') }}</span><span class="strong">v{{ check.current }} → v{{ check.latest.version }}</span></div>
        <template v-if="!oneRunning">
          <div v-if="check.latest.builtAt" class="kv"><span class="muted">{{ t('update.builtAt') }}</span><span>{{ formatDate(check.latest.builtAt) }}</span></div>
          <div class="kv"><span class="muted">{{ t('update.size') }}</span><span>{{ formatBytes(check.latest.size) }}</span></div>
          <div class="kv">
            <span class="muted">{{ t('update.signature') }}</span>
            <n-tag v-if="check.latest.signed" type="success" :bordered="false" class="sig"><template #icon><n-icon :component="ShieldCheckmarkOutline" /></template>{{ t('update.latestSigned') }}</n-tag>
            <n-tag v-else type="warning" :bordered="false" class="sig"><template #icon><n-icon :component="WarningOutline" /></template>{{ t('update.latestUnsigned') }}</n-tag>
          </div>
          <div v-if="check.latest.notes" class="kv"><span class="muted">{{ t('update.notes') }}</span><span class="notes">{{ check.latest.notes }}</span></div>
          <n-alert v-if="check.refused" type="error" :title="t('update.refusedTitle')" class="gap top">{{ t('update.refusedBody') }}</n-alert>
          <n-alert v-else-if="!check.latest.signed" type="error" :title="t('update.unsignedWebTitle')" class="gap top">{{ t('update.unsignedWebBody') }}</n-alert>
        </template>
      </template>

      <ol v-if="oneRunning || oneFailed?.step >= 0" class="steps" :aria-label="t('update.stepsLabel')">
        <li v-for="(s, i) in STEPS" :key="s" :class="stepState(i)" :aria-current="stepState(i) === 'active' ? 'step' : undefined">
          <n-icon class="step-icon" :component="stepIcon(i)" :color="stepState(i) === 'done' ? theme.successColor : undefined" />
          <span>{{ t(`update.step.${s}`) }}</span>
        </li>
      </ol>
      <p v-if="oneStep === STEPS.length - 1" class="muted small">{{ t('update.waiting') }}</p>

      <!-- kept until the next try; the step name is the page's own text, the reason is the server's -->
      <n-alert v-if="oneFailed" ref="failRef" type="error" :title="oneFailed.step >= 0 ? t('update.failedAt', { step: t(`update.step.${STEPS[oneFailed.step]}`) }) : t('update.oneFailed')" class="gap top refused">
        {{ oneFailed.message }}
      </n-alert>

      <template v-if="!oneRunning">
        <n-alert type="info" class="gap top">{{ t('update.restartNote') }}</n-alert>
        <n-alert v-if="st?.uploadsInProgress" type="warning" class="gap">{{ t('update.uploadsWarn', { n: st.uploadsInProgress }) }}</n-alert>
        <n-form label-placement="top" @submit.prevent="updateNow">
          <n-form-item :label="t('update.password')" :validation-status="onePwError ? 'error' : undefined" :feedback="onePwError || undefined">
            <n-input :placeholder="t('update.password')" v-model:value="onePassword" type="password" show-password-on="click" autocomplete="current-password" :input-props="{ name: 'confirm-password' }" @keyup.enter="updateNow" @update:value="onePwError = ''" />
          </n-form-item>
        </n-form>
      </template>
      <div class="actions">
        <n-button :disabled="oneRunning" @click="oneOpen = false">{{ t('common.cancel') }}</n-button>
        <n-button type="primary" :disabled="(!onePassword && !oneRunning) || check?.refused" :loading="oneRunning" @click="updateNow">
          <template #icon><n-icon :component="CloudDownloadOutline" /></template>{{ oneFailed ? t('common.retry') : t('update.updateNow') }}
        </n-button>
      </div>
    </n-modal>
  </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { NAlert, NButton, NForm, NFormItem, NIcon, NInput, NModal, NProgress, NSpin, NTag, NUpload, NUploadDragger, useThemeVars } from 'naive-ui'
import {
  ArrowUndoOutline, CheckmarkCircle, CloseCircle, CloudDownloadOutline, CloudUploadOutline, EllipseOutline, RefreshOutline,
  ShieldCheckmarkOutline, ShieldOutline, SyncOutline, WarningOutline,
} from '@vicons/ionicons5'
import { api, ApiError, putChunk } from '../api'
import { errorText, useFeedback } from '../composables'
import { bootId, sleep, waitForRestart } from '../restart'
import { formatBytes, formatDate } from '../utils'

const { t, locale } = useI18n()
const fb = useFeedback()
const route = useRoute()
const router = useRouter()
const theme = useThemeVars()
const st = ref(null)
const loading = ref(false)
const working = ref(false)
// idle -> uploading -> checking -> ready -> installing (page reloads when done); the one-step update goes idle -> installing
const phase = ref('idle')
const progress = ref(0)
const staged = ref(null)
// why the last dropped package was refused ({ name, message }), until the next one
const refused = ref(null)
const password = ref('')
const rollbackOpen = ref(false)
const rollbackTarget = ref(null)
// the answer of "check and update" ({ current, latest, newer }), and why the check failed (the server's text)
const check = ref(null)
const checking = ref(false)
const checkError = ref('')
// the one-step update dialog: the steps of POST /fetch-and-apply (params.step names them on a failure), then the restart
const STEPS = ['check', 'fetch', 'stage', 'apply', 'restart']
const oneOpen = ref(false)
const oneRunning = ref(false)
const onePassword = ref('')
// the highlighted step (-1 = none); why it failed ({ step: index or -1, message }); a wrong password, shown at the field
const oneStep = ref(-1)
const oneFailed = ref(null)
const onePwError = ref('')
const failRef = ref(null)
let stepTimers = []
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

/** read latest.json at the source; with `open`, a newer version opens the update dialog */
async function checkSource(open) {
  checking.value = true
  checkError.value = ''
  try {
    const r = await api.updateCheck()
    check.value = r.latest ? r : null
    if (open && r.newer) openOne()
  } catch (e) {
    check.value = null
    checkError.value = errorText(e, t('common.unknownError'))
  } finally { checking.value = false }
}
const checkAndUpdate = () => !busy.value && !checking.value && checkSource(true)

function openOne() {
  onePassword.value = ''
  oneFailed.value = null
  onePwError.value = ''
  oneStep.value = -1
  oneOpen.value = true
}

const stepState = i => {
  const failed = oneFailed.value?.step ?? -1
  if (failed >= 0) return i < failed ? 'done' : i === failed ? 'failed' : 'todo'
  return i < oneStep.value ? 'done' : i === oneStep.value ? 'active' : 'todo'
}
const stepIcon = i => ({ done: CheckmarkCircle, failed: CloseCircle, active: SyncOutline, todo: EllipseOutline })[stepState(i)]

function clearStepTimers() {
  stepTimers.forEach(clearTimeout)
  stepTimers = []
}
// the server answers once, at the end: move the highlight along at a likely pace (download ~3 MB/s, checking the files
// ~30 MB/s), and stay on "installing" until the answer; a failure names the real step (params.step)
function guessSteps(size) {
  const download = Math.max(2000, (size / 3e6) * 1000)
  const verify = Math.max(1500, (size / 30e6) * 1000)
  const at = (ms, i) => stepTimers.push(setTimeout(() => { if (oneRunning.value && oneStep.value < i) oneStep.value = i }, ms))
  at(1200, 1)
  at(1200 + download, 2)
  at(1200 + download + verify, 3)
}

async function updateNow() {
  if (!onePassword.value || oneRunning.value || !check.value?.latest) return
  const target = check.value.latest.version
  oneRunning.value = true
  oneFailed.value = null
  onePwError.value = ''
  oneStep.value = 0
  guessSteps(check.value.latest.size)
  let before
  try {
    before = await bootId()
    await api.updateFetchAndApply(onePassword.value)
  } catch (e) {
    clearStepTimers()
    oneRunning.value = false
    oneStep.value = -1
    const step = e instanceof ApiError ? e.params?.step : undefined
    const message = errorText(e, t('common.unknownError'))
    // wrong or locked password: nothing was fetched, say it at the field
    if (!step && (e?.code === 'auth.wrong-password' || e?.code === 'auth.confirm-locked')) onePwError.value = message
    else {
      oneFailed.value = { step: STEPS.indexOf(step), message }
      // on a phone the reason is below the steps, out of sight
      await nextTick()
      failRef.value?.$el?.scrollIntoView?.({ block: 'nearest' })
    }
    return
  }
  clearStepTimers()
  onePassword.value = ''
  oneStep.value = STEPS.length - 1
  if (await afterRestart(before, target)) return
  // still here: the wait timed out or the new version did not come up (afterRestart said which)
  oneRunning.value = false
  oneOpen.value = false
  check.value = null
}

// the server wrote these messages in the old language: ask again for a failed check (it only reads latest.json), and drop
// the others rather than show them next to labels in the new language (a failed step keeps its name, the page's own text)
watch(locale, () => {
  if (checkError.value && !busy.value) checkSource(false)
  if (oneFailed.value) oneFailed.value = { ...oneFailed.value, message: '' }
  onePwError.value = ''
  refused.value = null
})

async function discard() {
  const id = staged.value?.id
  staged.value = null
  phase.value = 'idle'
  password.value = ''
  if (id) { try { await api.updateDiscard(id) } catch { /* it is cleaned up later anyway */ } }
}

/** answers true when the page is reloading on the new version */
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
    return true
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

onMounted(async () => {
  poll = setInterval(() => { if (!busy.value && !rollbackOpen.value && !oneOpen.value) load() }, 15_000)
  await load()
  // from the dashboard's "update" button: check right away, and open the dialog when there is a newer version
  if (route.query.go) {
    const { go, ...rest } = route.query
    router.replace({ query: rest })
    if (st.value?.source?.enabled && canUpdate.value) checkAndUpdate()
  }
})
onBeforeUnmount(() => { clearInterval(poll); clearStepTimers() })
</script>

<style scoped>
.narrow { max-width: 760px; }
.block { padding: 22px; margin-bottom: 16px; }
.block h2 { margin: 0 0 12px; font-size: 16px; font-weight: 600; }
.gap { margin-bottom: 12px; }
.gap.top { margin-top: 14px; }
.refused { overflow-wrap: anywhere; }
.url { overflow-wrap: anywhere; text-align: right; min-width: 0; }
.steps { list-style: none; margin: 14px 0 6px; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.steps li { display: flex; align-items: center; gap: 10px; padding: 7px 10px; border-radius: 8px; font-size: 14px; color: var(--muted); }
.steps .step-icon { flex: none; font-size: 18px; }
.steps li.done { color: var(--text); }
.steps li.active { color: var(--primary); background: var(--primary-soft); font-weight: 600; }
.steps li.active .step-icon { animation: turn 1.4s linear infinite; }
.steps li.failed { color: var(--danger); font-weight: 600; }
@keyframes turn { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .steps li.active .step-icon { animation: none; } }
.kv { display: flex; justify-content: space-between; align-items: center; gap: 16px; padding: 9px 0; border-top: 1px solid var(--border); font-size: 14px; }
.kv:first-of-type { border-top: 0; }
.strong { font-weight: 600; }
.small { font-size: 12.5px; }
.notes { white-space: pre-wrap; text-align: right; max-width: 70%; overflow-wrap: anywhere; }
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
