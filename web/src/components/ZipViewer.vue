<template>
  <n-modal :show="show" preset="card" :title="name" :bordered="false" class="zip-modal" style="width: min(860px, 96vw)" @update:show="close">
    <template #header-extra>
      <n-button v-if="canExtract" size="small" secondary type="primary" :disabled="loading || !!error" @click="emit('extract')">
        <template #icon><n-icon :component="ExpandOutline" /></template>{{ t('zip.extract') }}
      </n-button>
    </template>

    <n-spin :show="loading">
      <div v-if="error" class="state">
        <n-alert type="warning" :title="error.message">
          <span v-if="error.code === 'archive.not-zip'">{{ t('zip.notZipHint') }}</span>
        </n-alert>
        <n-button class="retry" @click="load">{{ t('common.retry') }}</n-button>
      </div>

      <template v-else-if="!loading || entries.length">
        <!-- one file of the zip, drawn here -->
        <div v-if="pv" class="pv">
          <div class="pv-head">
            <n-button quaternary size="small" @click="closePreview"><template #icon><n-icon :component="ArrowBackOutline" /></template>{{ t('common.back') }}</n-button>
            <span class="pv-name">{{ pv.name }}</span>
            <n-button size="small" quaternary :loading="busyKey === pv.entry.name" @click="downloadEntry(pv.entry)"><template #icon><n-icon :component="DownloadOutline" /></template>{{ t('common.download') }}</n-button>
          </div>
          <div class="pv-body">
            <n-spin v-if="pv.loading" class="pv-spin" />
            <n-alert v-else-if="pv.error" type="warning">{{ pv.error }}</n-alert>
            <img v-else-if="pv.kind === 'image'" :src="pv.url" :alt="pv.name" class="pv-img">
            <iframe v-else-if="pv.kind === 'pdf'" :src="pv.url" class="pv-pdf" :title="pv.name" />
            <pre v-else class="pv-text">{{ pv.text }}</pre>
            <div v-if="pv.cut" class="muted small">{{ t('zip.textCut') }}</div>
          </div>
        </div>

        <template v-else>
          <div class="trail">
            <n-button v-if="cur" quaternary circle size="small" :title="t('common.back')" :aria-label="t('common.back')" @click="goUp"><template #icon><n-icon :component="ArrowBackOutline" /></template></n-button>
            <span v-for="(c, i) in crumbs" :key="c.path" class="crumb-wrap">
              <span v-if="i" class="sep">/</span>
              <button type="button" class="crumb" :class="{ last: i === crumbs.length - 1 }" @click="cur = c.path"><n-icon v-if="!c.path" :component="ArchiveOutline" /> {{ c.name }}</button>
            </span>
          </div>

          <n-alert v-if="truncated" type="warning" class="gap">{{ t('zip.truncated', { n: entries.length }) }}</n-alert>

          <div v-if="!rows.length" class="muted empty">{{ t('zip.empty') }}</div>
          <ul v-else class="rows">
            <li v-for="r in rows" :key="r.key" class="row">
              <button v-if="r.dir" type="button" class="main" @click="cur = r.path">
                <file-icon :item="{ name: r.name, type: 'dir' }" :size="24" />
                <span class="text">
                  <span class="nm">{{ r.name }}</span>
                  <span class="muted small">{{ t('zip.folderInfo', { n: r.count }) }} · {{ formatBytes(r.size) }}</span>
                </span>
              </button>
              <template v-else>
                <button type="button" class="main" :disabled="!r.previewable" :title="r.entry.encrypted ? t('zip.encrypted') : undefined" @click="r.previewable && openPreview(r)">
                  <file-icon :item="{ name: r.name, type: 'file' }" :size="24" />
                  <span class="text">
                    <span class="nm">{{ r.name }}<n-icon v-if="r.entry.encrypted" :component="LockClosedOutline" class="lock" :title="t('zip.encrypted')" /></span>
                    <span class="muted small">{{ formatBytes(r.entry.size) }} · {{ formatDate(r.entry.modified) }}<template v-if="r.entry.encrypted"> · {{ t('zip.encrypted') }}</template></span>
                  </span>
                </button>
                <span class="acts">
                  <n-button v-if="r.previewable" quaternary circle size="small" :title="t('files.preview')" :aria-label="t('files.preview')" @click="openPreview(r)"><template #icon><n-icon :component="EyeOutline" /></template></n-button>
                  <n-button quaternary circle size="small" :disabled="r.entry.encrypted" :loading="busyKey === r.entry.name" :title="r.entry.encrypted ? t('zip.encrypted') : t('common.download')" :aria-label="t('common.download')" @click="downloadEntry(r.entry)"><template #icon><n-icon :component="DownloadOutline" /></template></n-button>
                </span>
              </template>
            </li>
          </ul>
        </template>
      </template>
    </n-spin>
  </n-modal>
</template>

<script setup>
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { NAlert, NButton, NIcon, NModal, NSpin } from 'naive-ui'
import { ArchiveOutline, ArrowBackOutline, DownloadOutline, ExpandOutline, EyeOutline, LockClosedOutline } from '@vicons/ionicons5'
import { useFeedback } from '../composables'
import { MARKDOWN_EXT, CSV_EXT, TEXT_EXT, extOf, formatBytes, formatDate } from '../utils'
import FileIcon from './FileIcon.vue'

// Looks into a .zip without unpacking it. The entries come from the server as full names ("a/b/c.txt", a folder ends
// with "/"); the folders are built here from those names. One entry can be looked at (image, PDF, text) or saved.
// `source` says where the zip is: { list(): Promise<{ entries, truncated }>, fileUrl(entryName): string, inlineUrl?(entryName): string }
// (inlineUrl: the same entry for showing in a frame; without it a PDF is only offered for download).
const props = defineProps({
  show: Boolean,
  name: { type: String, default: '' },
  source: { type: Object, default: null },
  /** the viewer may also unpack the zip next to itself (write + zip): the parent does it */
  canExtract: Boolean,
})
const emit = defineEmits(['update:show', 'extract'])
const { t, te } = useI18n()
const fb = useFeedback()

const loading = ref(false)
const error = ref(null)
const entries = ref([])
const truncated = ref(false)
const cur = ref('')
const pv = ref(null)
const busyKey = ref('')
// the address of the picture/PDF being shown (made from the entry's bytes); let go of it when another comes or the window closes
let blobUrl = ''

const IMAGE = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif', 'ico']
const TEXT = [...TEXT_EXT, ...MARKDOWN_EXT, ...CSV_EXT]
const SHOW_MAX = 40 * 1024 * 1024
const TEXT_MAX = 1024 * 1024

const previewKind = n => {
  const e = extOf(n)
  if (IMAGE.includes(e)) return 'image'
  // the page's own security rules allow a frame from this server only (not from a blob): a PDF is shown from the
  // server's inline answer, which a download link does not give
  if (e === 'pdf') return props.source?.inlineUrl ? 'pdf' : ''
  if (TEXT.includes(e)) return 'text'
  return ''
}

const errorText = e => {
  const code = e?.code
  const key = code && `zip.err.${code.replace(/\./g, '_')}`
  return key && te(key) ? t(key) : e?.message || t('common.unknownError')
}

async function load() {
  if (!props.source) return
  loading.value = true
  error.value = null
  entries.value = []
  truncated.value = false
  try {
    const r = await props.source.list()
    entries.value = r.entries
    truncated.value = !!r.truncated
  } catch (e) {
    error.value = { code: e.code || '', message: errorText(e) }
  } finally {
    loading.value = false
  }
}

watch(() => [props.show, props.source], () => {
  closePreview()
  cur.value = ''
  if (props.show) load()
}, { immediate: true })

// ───── the folders of the zip, from the names ─────
const tree = computed(() => {
  const dirs = new Map([['', { path: '', name: '', dirs: new Set(), files: [], count: 0, size: 0 }]])
  const ensure = parts => {
    let path = ''
    for (const p of parts) {
      const parent = dirs.get(path)
      path += `${p}/`
      parent.dirs.add(path)
      if (!dirs.has(path)) dirs.set(path, { path, name: p, dirs: new Set(), files: [], count: 0, size: 0 })
    }
    return path
  }
  for (const e of entries.value) {
    const parts = e.name.split('/').filter(Boolean)
    if (!parts.length) continue
    if (e.dir) { ensure(parts); continue }
    const where = ensure(parts.slice(0, -1))
    dirs.get(where).files.push({ name: parts[parts.length - 1], entry: e })
    // counted into every folder above it
    let path = ''
    const chain = ['', ...parts.slice(0, -1).map(p => (path += `${p}/`))]
    for (const c of chain) { const d = dirs.get(c); d.count++; d.size += e.size }
  }
  return dirs
})

const cmp = (a, b) => a.localeCompare(b, 'th', { numeric: true })
const rows = computed(() => {
  const d = tree.value.get(cur.value)
  if (!d) return []
  const dirRows = [...d.dirs].map(p => tree.value.get(p)).sort((a, b) => cmp(a.name, b.name))
    .map(x => ({ key: `d${x.path}`, dir: true, path: x.path, name: x.name, count: x.count, size: x.size }))
  const fileRows = [...d.files].sort((a, b) => cmp(a.name, b.name))
    .map(f => ({ key: `f${f.entry.name}`, dir: false, name: f.name, entry: f.entry, previewable: !f.entry.encrypted && !!previewKind(f.name) && f.entry.size <= SHOW_MAX }))
  return [...dirRows, ...fileRows]
})
const crumbs = computed(() => {
  const out = [{ name: props.name || '/', path: '' }]
  let acc = ''
  for (const p of cur.value.split('/').filter(Boolean)) { acc += `${p}/`; out.push({ name: p, path: acc }) }
  return out
})
function goUp() {
  const parts = cur.value.split('/').filter(Boolean)
  parts.pop()
  cur.value = parts.length ? `${parts.join('/')}/` : ''
}

// ───── one entry ─────
/** an error answer of the server → { code, message } in our words */
async function failure(res) {
  let data = null
  try { data = await res.json() } catch { /* not JSON */ }
  return { code: data?.code || '', message: data?.error || t('api.failed', { status: res.status }) }
}

function dropBlob() {
  if (blobUrl) URL.revokeObjectURL(blobUrl)
  blobUrl = ''
}
function closePreview() {
  dropBlob()
  pv.value = null
}

async function openPreview(r) {
  closePreview()
  const kind = previewKind(r.name)
  const state = reactive({ name: r.name, entry: r.entry, kind, loading: true, error: '', url: '', text: '', cut: false })
  pv.value = state
  try {
    const url = kind === 'pdf' ? props.source.inlineUrl(r.entry.name) : props.source.fileUrl(r.entry.name)
    const ac = new AbortController()
    const res = await fetch(url, { credentials: 'same-origin', signal: ac.signal })
    if (!res.ok) throw await failure(res)
    if (pv.value !== state) return
    if (kind === 'pdf') {
      // the answer is good (the server reads the first piece before it says so): let the frame fetch it itself
      ac.abort()
      state.url = url
    } else if (kind === 'text') {
      const buf = await res.arrayBuffer()
      state.cut = buf.byteLength > TEXT_MAX
      state.text = new TextDecoder('utf-8').decode(buf.slice(0, TEXT_MAX))
    } else {
      const blob = new Blob([await res.arrayBuffer()], { type: res.headers.get('content-type') || '' })
      if (pv.value !== state) return
      blobUrl = URL.createObjectURL(blob)
      state.url = blobUrl
    }
  } catch (e) {
    if (pv.value === state) state.error = errorText(e)
  } finally {
    if (pv.value === state) state.loading = false
  }
}

/**
 * Save one entry. The request is started here first so a refusal (locked, damaged, too big) is told in words; once the
 * answer is a good one it is let go and the browser's own download takes over.
 */
async function downloadEntry(e) {
  if (busyKey.value) return
  busyKey.value = e.name
  const url = props.source.fileUrl(e.name)
  const ac = new AbortController()
  try {
    const res = await fetch(url, { credentials: 'same-origin', signal: ac.signal })
    if (!res.ok) throw await failure(res)
    ac.abort()
    const a = document.createElement('a')
    a.href = url
    a.download = e.name.split('/').filter(Boolean).pop() || 'file'
    a.rel = 'noopener'
    a.style.display = 'none'
    document.body.appendChild(a)
    a.click()
    a.remove()
  } catch (err) {
    fb.warn(errorText(err))
  } finally {
    busyKey.value = ''
  }
}

function close(v) {
  if (!v) closePreview()
  emit('update:show', v)
}
onBeforeUnmount(dropBlob)
</script>

<style scoped>
.state { padding: 8px 0; display: flex; flex-direction: column; align-items: flex-start; gap: 12px; }
.gap { margin-bottom: 10px; }
.small { font-size: 12.5px; }
.trail { display: flex; flex-wrap: wrap; align-items: center; gap: 2px 4px; margin-bottom: 10px; min-height: 28px; }
.crumb-wrap { display: inline-flex; align-items: center; gap: 4px; min-width: 0; }
.sep { color: var(--muted); }
.crumb { all: unset; cursor: pointer; padding: 2px 6px; border-radius: 6px; overflow-wrap: anywhere; font-size: 14px; }
.crumb:hover { background: var(--primary-soft); }
.crumb.last { font-weight: 600; }
.crumb:focus-visible { outline: 2px solid var(--primary); }
.crumb .n-icon { vertical-align: -2px; }
.empty { padding: 28px 0; text-align: center; }
.rows { list-style: none; margin: 0; padding: 0; border: 1px solid var(--border); border-radius: 10px; overflow: hidden; max-height: 60vh; overflow-y: auto; }
.row { display: flex; align-items: center; gap: 6px; border-top: 1px solid var(--border); padding-right: 6px; }
.row:first-child { border-top: 0; }
.main { all: unset; box-sizing: border-box; flex: 1; min-width: 0; display: flex; align-items: center; gap: 12px; padding: 9px 6px 9px 12px; cursor: pointer; }
.main:disabled { cursor: default; }
.main:not(:disabled):hover .nm { color: var(--primary); }
.main:focus-visible { outline: 2px solid var(--primary); outline-offset: -2px; }
.text { min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.nm { overflow-wrap: anywhere; font-weight: 500; line-height: 1.4; }
.lock { margin-left: 6px; vertical-align: -2px; color: var(--folder); }
.acts { display: flex; flex: none; gap: 2px; }
.pv-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }
.pv-name { flex: 1 1 160px; min-width: 0; overflow-wrap: anywhere; font-weight: 600; }
.pv-body { min-height: 160px; max-height: 64vh; overflow: auto; border-radius: 8px; background: var(--surface-2); display: grid; place-items: center; padding: 8px; }
.pv-img { max-width: 100%; max-height: 60vh; }
.pv-pdf { width: 100%; height: 60vh; border: 0; }
.pv-text { margin: 0; width: 100%; align-self: start; white-space: pre-wrap; overflow-wrap: anywhere; font: 13px/1.5 ui-monospace, Menlo, Consolas, monospace; }
.pv-spin { margin: 40px 0; }
.retry { align-self: flex-start; }
</style>
