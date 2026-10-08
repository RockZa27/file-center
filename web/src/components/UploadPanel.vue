<template>
  <transition name="slide">
    <div v-if="queue.length" class="panel surface">
      <div class="head" @click="collapsed = !collapsed">
        <n-icon :component="CloudUploadOutline" size="18" />
        <div class="grow">
          <div class="title">{{ busy ? t('upload.uploading', { n: active }) : t('upload.finished') }}</div>
          <div class="sub muted">{{ t('upload.summary', { ok: counts.done, failed: counts.error, total: queue.length }) }}</div>
        </div>
        <n-button v-if="!busy" quaternary circle size="small" :title="t('common.close')" @click.stop="clearFinished"><template #icon><n-icon :component="CloseOutline" /></template></n-button>
        <n-icon :component="collapsed ? ChevronUpOutline : ChevronDownOutline" />
      </div>
      <div v-show="!collapsed" class="list">
        <div v-for="it in queue" :key="it.key" class="item">
          <div class="line">
            <span class="name truncate" :title="it.displayName">{{ it.displayName }}</span>
            <span class="muted size">{{ formatBytes(it.size) }}</span>
          </div>
          <n-progress type="line" :percentage="percent(it)" :status="statusOf(it)" :show-indicator="false" :height="6" :processing="it.status === 'uploading'" />
          <div class="line meta">
            <span :class="{ err: it.status === 'error' }" class="muted">{{ label(it) }}</span>
            <span class="actions">
              <n-button v-if="it.status === 'uploading'" text size="tiny" @click="it.paused = true; it.status = 'paused'">{{ t('upload.pause') }}</n-button>
              <n-button v-if="it.status === 'paused'" text type="primary" size="tiny" @click="it.paused = false; it.status = 'uploading'">{{ t('upload.resume') }}</n-button>
              <n-button v-if="it.status === 'error'" text type="primary" size="tiny" @click="retry(it)">{{ t('common.retry') }}</n-button>
              <n-button v-if="['queued', 'uploading', 'paused', 'error'].includes(it.status)" text type="error" size="tiny" @click="cancel(it)">{{ t('common.cancel') }}</n-button>
            </span>
          </div>
        </div>
      </div>
    </div>
  </transition>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { NButton, NIcon, NProgress } from 'naive-ui'
import { ChevronDownOutline, ChevronUpOutline, CloseOutline, CloudUploadOutline } from '@vicons/ionicons5'
import { api, putChunk } from '../api'
import { useFeedback } from '../composables'
import { useAppStore } from '../store'
import { formatBytes, formatDuration } from '../utils'

const props = defineProps({ space: { type: String, required: true } })
const emit = defineEmits(['uploaded'])
const { t } = useI18n()
const app = useAppStore()
const fb = useFeedback()

const queue = ref([])
const collapsed = ref(false)
let running = false
let seq = 0
let refreshTimer = null

const counts = computed(() => ({
  done: queue.value.filter(i => i.status === 'done').length,
  error: queue.value.filter(i => i.status === 'error').length,
}))
const active = computed(() => queue.value.filter(i => ['queued', 'uploading', 'paused'].includes(i.status)).length)
const busy = computed(() => active.value > 0)

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
    queue.value.push(reactive({
      key: ++seq, file, displayName, relativeDir, path, space: props.space, size: file.size,
      loaded: 0, status: 'queued', error: '', id: null, paused: false, canceled: false, aborts: new Set(), started: 0,
    }))
  }
  collapsed.value = false
  pump()
}

async function pump() {
  if (running) return
  running = true
  try {
    for (let next = queue.value.find(i => i.status === 'queued'); next; next = queue.value.find(i => i.status === 'queued')) {
      await upload(next)
    }
  } finally {
    running = false
    emit('uploaded')
  }
}

async function upload(it) {
  it.status = 'uploading'
  it.started = Date.now()
  it.loaded = 0
  it.error = ''
  try {
    const init = await api.uploadInit(it.space, it.path, it.file.name, it.size, it.relativeDir)
    it.id = init.id
    const { chunkSize, total } = init
    const sent = new Array(total).fill(0)
    const pending = [...Array(total).keys()]
    let failure = null
    const sync = () => { it.loaded = sent.reduce((a, b) => a + b, 0) }

    const worker = async () => {
      while (!it.canceled && !failure) {
        if (it.paused) { await sleep(250); continue }
        const idx = pending.shift()
        if (idx === undefined) return
        const blob = it.file.slice(idx * chunkSize, Math.min(it.size, (idx + 1) * chunkSize))
        for (let attempt = 0; ; attempt++) {
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
            await sleep(1000 * (attempt + 1))
          }
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(app.config.uploadSimultaneous || 3, total) }, worker))
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
  }
}

function scheduleRefresh() {
  clearTimeout(refreshTimer)
  refreshTimer = setTimeout(() => emit('uploaded'), 800)
}

function cancel(it) {
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
  queue.value = queue.value.filter(i => ['queued', 'uploading', 'paused'].includes(i.status))
}

const beforeUnload = e => { if (busy.value) { e.preventDefault(); e.returnValue = '' } }
onMounted(() => window.addEventListener('beforeunload', beforeUnload))
onBeforeUnmount(() => window.removeEventListener('beforeunload', beforeUnload))

defineExpose({ add })
</script>

<style scoped>
.panel { position: fixed; right: 20px; bottom: 20px; width: min(380px, calc(100vw - 24px)); z-index: 60; box-shadow: 0 10px 30px rgba(0, 0, 0, 0.18); overflow: hidden; }
.head { display: flex; align-items: center; gap: 10px; padding: 12px 14px; cursor: pointer; background: var(--surface-2); }
.title { font-weight: 600; font-size: 14px; }
.sub { font-size: 12px; }
.list { max-height: 320px; overflow-y: auto; }
.item { padding: 10px 14px; border-top: 1px solid var(--border); }
.line { display: flex; justify-content: space-between; gap: 10px; align-items: center; font-size: 13px; margin-bottom: 6px; }
.line.meta { margin: 6px 0 0; font-size: 12px; }
.name { min-width: 0; }
.size { flex: none; font-size: 12px; }
.err { color: var(--danger); }
.actions { display: flex; gap: 10px; flex: none; }
.slide-enter-active, .slide-leave-active { transition: transform 0.2s ease, opacity 0.2s; }
.slide-enter-from, .slide-leave-to { transform: translateY(16px); opacity: 0; }
</style>
