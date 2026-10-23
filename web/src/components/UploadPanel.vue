<template>
  <transition name="slide">
    <div v-if="queue.length" ref="panelEl" class="panel surface" :class="{ strip: collapsed }">
      <div class="head" role="button" tabindex="0" :aria-expanded="!collapsed" @click="collapsed = !collapsed" @keydown.enter="collapsed = !collapsed">
        <n-icon :component="CloudUploadOutline" size="18" />
        <div class="grow">
          <div class="title">{{ busy ? t('upload.uploading', { n: active }) : t('upload.finished') }}</div>
          <div class="sub muted">{{ t('upload.summary', { ok: counts.done, failed: counts.error, total: queue.length }) }}</div>
        </div>
        <n-button v-if="!busy" quaternary circle size="small" :title="t('common.close')" @click.stop="clearFinished"><template #icon><n-icon :component="CloseOutline" /></template></n-button>
        <n-icon :component="collapsed ? ChevronUpOutline : ChevronDownOutline" />
      </div>
      <n-progress v-if="busy" class="overall" type="line" :percentage="overall" :show-indicator="false" :height="3" :border-radius="0" :processing="true" />
      <div v-show="!collapsed" class="list">
        <div v-for="it in queue" :key="it.key" class="item">
          <div class="line">
            <span class="name" :title="it.displayName">{{ it.displayName }}</span>
            <span class="muted size">{{ formatBytes(it.size) }}</span>
          </div>
          <n-progress type="line" :percentage="percent(it)" :status="statusOf(it)" :show-indicator="false" :height="6" :processing="it.status === 'uploading'" />
          <div class="line meta">
            <span :class="{ err: it.status === 'error' }" class="muted">{{ label(it) }}</span>
            <span class="actions">
              <n-button v-if="it.status === 'uploading'" text size="tiny" @click="it.paused = true; it.status = 'paused'">{{ t('upload.pause') }}</n-button>
              <n-button v-if="it.status === 'paused'" text type="primary" size="tiny" @click="it.paused = false; it.status = 'uploading'">{{ t('upload.resume') }}</n-button>
              <n-button v-if="it.status === 'error' && !it.final" text type="primary" size="tiny" @click="retry(it)">{{ t('common.retry') }}</n-button>
              <n-button v-if="['queued', 'uploading', 'paused', 'error'].includes(it.status)" text type="error" size="tiny" @click="cancel(it)">{{ it.final ? t('common.remove') : t('common.cancel') }}</n-button>
            </span>
          </div>
        </div>
      </div>
    </div>
  </transition>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { NButton, NIcon, NProgress } from 'naive-ui'
import { ChevronDownOutline, ChevronUpOutline, CloseOutline, CloudUploadOutline } from '@vicons/ionicons5'
import { api, putChunk } from '../api'
import { useFeedback } from '../composables'
import { useAppStore } from '../store'
import { NAME_MAX_BYTES, nameProblem } from '../upload-utils'
import { createPool } from '../uploadPool'
import { formatBytes, formatDuration } from '../utils'

const props = defineProps({ space: { type: String, required: true } })
const emit = defineEmits(['uploaded'])
const { t } = useI18n()
const app = useAppStore()
const fb = useFeedback()

const queue = ref([])
// a phone starts with a one-line strip (it sits above the bar for a selection); a wide screen with the list open
const phone = window.matchMedia('(max-width: 960px)').matches
const collapsed = ref(phone)
let runners = 0
const FILES_AT_ONCE = 3
// one limit of chunk requests in flight for all files together
const pool = createPool(() => app.config.uploadSimultaneous || 3)
let seq = 0
let refreshTimer = null

const counts = computed(() => ({
  done: queue.value.filter(i => i.status === 'done').length,
  error: queue.value.filter(i => i.status === 'error').length,
}))
const active = computed(() => queue.value.filter(i => ['queued', 'uploading', 'paused'].includes(i.status)).length)
const busy = computed(() => active.value > 0)
const overall = computed(() => {
  const total = queue.value.reduce((a, i) => a + (i.size || 0), 0)
  return total ? Math.min(100, Math.round((queue.value.reduce((a, i) => a + (i.status === 'done' ? i.size : i.loaded || 0), 0) / total) * 100)) : 0
})

// the height of the panel is shared, so the list can leave room for it at the bottom of a phone screen
const panelEl = ref(null)
let panelObs = null
watch(panelEl, el => {
  panelObs?.disconnect()
  panelObs = null
  if (!el) return document.documentElement.style.removeProperty('--upload-h')
  const set = () => document.documentElement.style.setProperty('--upload-h', `${el.offsetHeight}px`)
  set()
  panelObs = new ResizeObserver(set)
  panelObs.observe(el)
}, { flush: 'post' })

const percent = it => (it.size ? Math.min(100, Math.round((it.loaded / it.size) * 100)) : it.status === 'done' ? 100 : 0)
const statusOf = it => ({ done: 'success', error: 'error' })[it.status] || 'default'

function label(it) {
  if (it.status === 'queued') return t('upload.queued')
  if (it.status === 'paused') return t('upload.paused')
  if (it.status === 'done') return t('upload.done')
  if (it.status === 'canceled') return t('upload.canceled')
  if (it.status === 'error') return it.error || t('common.unknownError')
  const elapsed = (Date.now() - it.started) / 1000
  const rate = elapsed > 1 ? it.loaded / elapsed : 0
  const left = rate > 0 ? (it.size - it.loaded) / rate : 0
  return `${percent(it)}% · ${formatBytes(rate)}/s${left ? ' · ' + t('upload.remaining', { time: formatDuration(left) }) : ''}`
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

function add(list, path) {
  const max = app.config.uploadMaxSize
  for (const { file, relativeDir } of list) {
    const displayName = relativeDir ? `${relativeDir}/${file.name}` : file.name
    if (max && file.size > max) {
      fb.warn(t('upload.tooBig', { name: file.name, max: formatBytes(max) }))
      continue
    }
    const item = reactive({
      key: ++seq, file, displayName, relativeDir, path, space: props.space, size: file.size,
      loaded: 0, status: 'queued', error: '', id: null, chunkSize: 0, total: 0, paused: false, canceled: false, aborts: new Set(), started: 0, final: false,
    })
    // a name the file system can not hold is told here, per file, before anything is sent (trying again changes nothing)
    const bad = nameProblem(file.name, relativeDir)
    if (bad) {
      item.status = 'error'
      item.final = true
      item.error = bad.kind === 'folder'
        ? t('upload.folderNameTooLong', { name: bad.name, max: NAME_MAX_BYTES })
        : t('upload.nameTooLong', { max: NAME_MAX_BYTES })
    }
    queue.value.push(item)
  }
  if (!phone) collapsed.value = false
  pump()
}

function pump() {
  while (runners < FILES_AT_ONCE && queue.value.some(i => i.status === 'queued')) {
    runners++
    runner().finally(() => {
      runners--
      // once, when the last one is out of work
      if (runners === 0) emit('uploaded')
    })
  }
}

async function runner() {
  for (let next = queue.value.find(i => i.status === 'queued'); next; next = queue.value.find(i => i.status === 'queued')) {
    await upload(next)
  }
}

async function upload(it) {
  it.status = 'uploading'
  it.started = Date.now()
  it.loaded = 0
  it.error = ''
  try {
    // a retry resumes the upload the server still holds (its temp data and quota hold) instead of starting a second one
    let init = it.id ? await resume(it) : null
    if (!init) {
      init = await api.uploadInit(it.space, it.path, it.file.name, it.size, it.relativeDir)
      it.id = init.id
      it.chunkSize = init.chunkSize
      it.total = init.total
    }
    const { chunkSize, total } = init
    const have = new Set(init.received || [])
    const sent = Array.from({ length: total }, (_, i) => (have.has(i) ? Math.min(chunkSize, it.size - i * chunkSize) : 0))
    const pending = [...Array(total).keys()].filter(i => !have.has(i))
    it.loaded = sent.reduce((a, b) => a + b, 0)
    let failure = null
    const sync = () => { it.loaded = sent.reduce((a, b) => a + b, 0) }

    const worker = async () => {
      while (!it.canceled && !failure) {
        if (it.paused) { await sleep(250); continue }
        await pool.acquire()
        let held = true
        try {
          // things may have changed while waiting for a slot
          if (it.canceled || failure) return
          if (it.paused) continue
          const idx = pending.shift()
          if (idx === undefined) return
          const blob = it.file.slice(idx * chunkSize, Math.min(it.size, (idx + 1) * chunkSize))
          for (let attempt = 0; ; attempt++) {
            if (!held) { await pool.acquire(); held = true; if (it.canceled) return }
            try {
              await putChunk(it.id, idx, blob, loaded => { sent[idx] = loaded; sync() }, abort => it.aborts.add(abort))
              sent[idx] = blob.size
              sync()
              break
            } catch (e) {
              if (it.canceled) return
              // 507 = server disk full, retrying will not help
              const retryable = e.status === 0 || (e.status >= 500 && e.status !== 507)
              if (!retryable || attempt >= 3) { failure = e; return }
              sent[idx] = 0
              sync()
              // do not keep a slot while waiting
              pool.release(); held = false
              await sleep(1000 * (attempt + 1))
            }
          }
        } finally {
          if (held) pool.release()
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(Math.max(1, app.config.uploadSimultaneous || 3), total) }, worker))
    if (it.canceled) return
    if (failure) throw failure
    await api.uploadComplete(it.id)
    it.loaded = it.size
    it.status = 'done'
    scheduleRefresh()
  } catch (e) {
    if (it.canceled) return
    it.status = 'error'
    it.error = e.message
    // the folder is gone and the server dropped the upload: trying again would fail the same way
    if (e.code === 'upload.dest-gone') { it.final = true; it.id = null }
    // the storage is full: the message holds used/quota; say which file it was, the others in the queue may still fit
    if (e.code === 'quota.exceeded') fb.warn(t('upload.quotaFailed', { name: it.displayName, message: e.message }))
  }
}

/** the server's view of this item's upload: { chunkSize, total, received }, or null when it is gone (the old one is cancelled) */
async function resume(it) {
  try {
    const st = await api.uploadStatus(it.id)
    if (st.total === it.total && Array.isArray(st.received)) return { chunkSize: it.chunkSize, total: st.total, received: st.received }
  } catch (e) {
    // offline or a server error: say so and keep the id, the next retry looks again
    if (e.status !== 404 && e.status !== 403) throw e
  }
  const old = it.id
  it.id = null
  await api.uploadCancel(old).catch(() => {})
  return null
}

function scheduleRefresh() {
  clearTimeout(refreshTimer)
  refreshTimer = setTimeout(() => emit('uploaded'), 800)
}

function cancel(it) {
  // a file that was never sent just leaves the list
  if (it.final) { if (it.id) api.uploadCancel(it.id).catch(() => {}); queue.value = queue.value.filter(i => i !== it); return }
  it.canceled = true
  it.status = 'canceled'
  it.aborts.forEach(a => a())
  if (it.id) api.uploadCancel(it.id).catch(() => {})
}

function retry(it) {
  it.status = 'queued'
  it.canceled = false
  it.paused = false
  pump()
}

function clearFinished() {
  // a failed item that is dropped from the list must not keep its upload (and the quota it holds) on the server
  for (const i of queue.value) if (i.status === 'error' && i.id) { api.uploadCancel(i.id).catch(() => {}); i.id = null }
  queue.value = queue.value.filter(i => ['queued', 'uploading', 'paused'].includes(i.status))
}

const beforeUnload = e => { if (busy.value) { e.preventDefault(); e.returnValue = '' } }
onMounted(() => window.addEventListener('beforeunload', beforeUnload))
onBeforeUnmount(() => { window.removeEventListener('beforeunload', beforeUnload); panelObs?.disconnect(); document.documentElement.style.removeProperty('--upload-h') })

defineExpose({ add })
</script>

<style scoped>
.panel { position: fixed; right: 20px; bottom: 20px; width: min(380px, calc(100vw - 24px)); z-index: 60; box-shadow: 0 10px 30px rgba(0, 0, 0, 0.18); overflow: hidden; }
.head { display: flex; align-items: center; gap: 10px; padding: 12px 14px; cursor: pointer; background: var(--surface-2); }
.title { font-weight: 600; font-size: 14px; }
.sub { font-size: 12px; }
.list { max-height: 320px; overflow-y: auto; }
.item { padding: 10px 14px; border-top: 1px solid var(--border); }
.line { display: flex; justify-content: space-between; gap: 10px; align-items: baseline; font-size: 13px; margin-bottom: 6px; }
.line.meta { margin: 6px 0 0; font-size: 12px; }
.name { min-width: 0; overflow-wrap: anywhere; line-height: 1.4; }
.size { flex: none; font-size: 12px; }
.err { color: var(--danger); overflow-wrap: anywhere; min-width: 0; }
.actions { display: flex; gap: 10px; flex: none; }
@media (max-width: 960px) {
  /* a strip across the bottom, above the bar for a selection */
  .panel { left: 8px; right: 8px; width: auto; bottom: calc(var(--selbar-h, 0px) + 8px + env(safe-area-inset-bottom)); }
  .head { padding: 8px 12px; }
  .sub { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .grow { min-width: 0; }
  .list { max-height: 40vh; }
}
.overall { display: block; }
.slide-enter-active, .slide-leave-active { transition: transform 0.2s ease, opacity 0.2s; }
.slide-enter-from, .slide-leave-to { transform: translateY(16px); opacity: 0; }
</style>
