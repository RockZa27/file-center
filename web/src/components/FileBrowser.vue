<template>
  <div class="browser" @dragenter="onDragEnter" @dragover.prevent @dragleave="onDragLeave" @drop.prevent="onDrop">
    <div class="toolbar">
      <div class="left">
        <n-dropdown v-if="can('upload')" trigger="click" :options="uploadOptions" @select="onUploadSelect">
          <n-button type="primary">
            <template #icon><n-icon :component="CloudUploadOutline" /></template>{{ t('common.upload') }}
          </n-button>
        </n-dropdown>
        <n-dropdown v-if="can('write')" trigger="click" :options="createOptions" @select="onCreateSelect">
          <n-button secondary>
            <template #icon><n-icon :component="AddOutline" /></template>{{ t('common.create') }}
          </n-button>
        </n-dropdown>
      </div>
      <div class="right">
        <n-button quaternary circle :title="t('common.search')" @click="searchOpen = true"><template #icon><n-icon :component="SearchOutline" /></template></n-button>
        <n-button quaternary circle :title="t('common.refresh')" :loading="loading" @click="load()"><template #icon><n-icon :component="RefreshOutline" /></template></n-button>
        <n-button quaternary circle :title="showHidden ? t('files.hideHidden') : t('files.showHidden')" @click="showHidden = !showHidden">
          <template #icon><n-icon :component="showHidden ? EyeOutline : EyeOffOutline" /></template>
        </n-button>
        <n-button-group size="small">
          <n-button :type="app.view === 'list' ? 'primary' : 'default'" :secondary="app.view === 'list'" :title="t('files.viewList')" @click="app.setView('list')"><template #icon><n-icon :component="ListOutline" /></template></n-button>
          <n-button :type="app.view === 'grid' ? 'primary' : 'default'" :secondary="app.view === 'grid'" :title="t('files.viewGrid')" @click="app.setView('grid')"><template #icon><n-icon :component="GridOutline" /></template></n-button>
        </n-button-group>
      </div>
    </div>

    <div class="crumbs">
      <n-button v-if="location !== '/'" quaternary circle size="small" :title="t('common.back')" @click="go(parentPath(location))">
        <template #icon><n-icon :component="ArrowBackOutline" /></template>
      </n-button>
      <n-breadcrumb>
        <n-breadcrumb-item v-for="c in crumbs" :key="c.path" @click="go(c.path)">
          <span class="crumb"><n-icon v-if="c.path === '/'" :component="HomeOutline" />{{ c.name }}</span>
        </n-breadcrumb-item>
      </n-breadcrumb>
      <span class="count muted">{{ t('files.itemCount', { n: visible.length }) }}</span>
    </div>

    <transition name="fade">
      <div v-if="selected.length" class="selection">
        <span class="sel-count">{{ t('files.selected', { n: selected.length }) }}</span>
        <div class="sel-actions">
          <n-button v-if="can('download') && can('batchdownload')" size="small" secondary @click="downloadMany(selected)"><template #icon><n-icon :component="DownloadOutline" /></template>{{ t('common.download') }}</n-button>
          <n-button v-if="can('write')" size="small" secondary @click="pick('copy', selected)"><template #icon><n-icon :component="CopyOutline" /></template>{{ t('files.copyTo') }}</n-button>
          <n-button v-if="can('write')" size="small" secondary @click="pick('move', selected)"><template #icon><n-icon :component="ReturnUpForwardOutline" /></template>{{ t('files.moveTo') }}</n-button>
          <n-button v-if="can('zip') && can('write')" size="small" secondary @click="askZip(selected)"><template #icon><n-icon :component="ArchiveOutline" /></template>{{ t('files.zip') }}</n-button>
          <n-button v-if="can('write')" size="small" secondary type="error" @click="remove(selected)"><template #icon><n-icon :component="TrashOutline" /></template>{{ t('common.delete') }}</n-button>
          <n-button size="small" quaternary @click="checked = []">{{ t('files.clearSelection') }}</n-button>
        </div>
      </div>
    </transition>

    <div class="content surface">
      <n-spin :show="loading && !items.length">
        <div v-if="error" class="empty"><n-result status="warning" :title="error"><template #footer><n-button @click="load()">{{ t('common.retry') }}</n-button></template></n-result></div>
        <div v-else-if="!loading && !visible.length" class="empty">
          <n-empty :description="can('write') ? t('files.emptyTitle') : (emptyText || t('files.emptyReadonly'))">
            <template v-if="can('upload')" #extra>
              <p class="muted small">{{ t('files.emptyText') }}</p>
              <n-button type="primary" @click="pickFiles(false)"><template #icon><n-icon :component="CloudUploadOutline" /></template>{{ t('files.uploadFiles') }}</n-button>
            </template>
          </n-empty>
        </div>
        <n-data-table
          v-else-if="app.view === 'list'"
          :columns="columns" :data="sorted" :row-key="r => r.path" :checked-row-keys="checked"
          :row-props="rowProps" :pagination="{ pageSize: 50, showSizePicker: true, pageSizes: [25, 50, 100, 200] }"
          :bordered="false" :single-line="false" :scroll-x="620"
          @update:checked-row-keys="k => (checked = k)" @update:sorter="onSorter"
        />
        <div v-else class="grid">
          <div v-for="it in gridItems" :key="it.path" class="card" :class="{ on: checked.includes(it.path) }" @contextmenu.prevent="openContext($event, it)">
            <button type="button" class="card-main" @click="open(it)">
              <div class="thumb">
                <img v-if="it.type === 'file' && isImage(it.name) && can('download')" :src="api.downloadUrl(space, it.path, true)" loading="lazy" :alt="it.name">
                <file-icon v-else :item="it" :size="44" />
              </div>
              <div class="card-name" :title="it.name">{{ it.name }}</div>
              <div class="card-meta muted">{{ it.type === 'dir' ? t('common.folder') : formatBytes(it.size) }}</div>
            </button>
            <n-checkbox v-if="selectable" class="card-check" :checked="checked.includes(it.path)" @update:checked="v => toggle(it, v)" />
            <n-dropdown v-if="actionsFor(it).length" trigger="click" placement="bottom-end" :options="actionsFor(it)" @select="k => run(k, it)">
              <n-button class="card-menu" quaternary circle size="small"><template #icon><n-icon :component="EllipsisHorizontal" /></template></n-button>
            </n-dropdown>
          </div>
          <div v-if="gridItems.length < sorted.length" class="more"><n-button secondary @click="gridLimit += 120">{{ t('files.showMore', { n: sorted.length - gridItems.length }) }}</n-button></div>
        </div>
      </n-spin>
      <div v-if="hiddenCount && !showHidden" class="hidden-note muted">
        {{ t('files.hiddenCount', { n: hiddenCount }) }}
        <n-button text type="primary" size="small" @click="showHidden = true">{{ t('files.show') }}</n-button>
      </div>
    </div>

    <div v-if="dragging" class="drop"><n-icon :component="CloudUploadOutline" size="48" /><div>{{ t('files.dropHere', { folder: location }) }}</div></div>

    <n-dropdown placement="bottom-start" trigger="manual" :x="ctx.x" :y="ctx.y" :options="ctx.options" :show="ctx.show" :on-clickoutside="() => (ctx.show = false)" @select="k => { ctx.show = false; run(k, ctx.item) }" />

    <input ref="fileInput" type="file" multiple hidden @change="onPicked">
    <input ref="folderInput" type="file" webkitdirectory hidden @change="onPicked">

    <upload-panel v-if="can('upload')" ref="uploader" :space="space" @uploaded="load(true)" />
    <search-modal v-model:show="searchOpen" :space="space" :start="location" @select="onSearchSelect" />
    <folder-picker v-model:show="picker.show" :space="space" :title="picker.title" :confirm-text="picker.confirm" :initial="location" @select="onPicked2" />
    <preview-modal v-model:show="preview.show" :space="space" :item="preview.item" :siblings="visible" :can-edit="can('write')" :can-download="can('download')" @saved="load(true)" />

    <n-modal v-model:show="prompt.show" preset="card" :title="prompt.title" style="width: min(440px, 94vw)">
      <n-input ref="promptInput" v-model:value="prompt.value" :placeholder="prompt.label" @keyup.enter="submitPrompt" />
      <template #footer>
        <div class="foot"><n-button @click="prompt.show = false">{{ t('common.cancel') }}</n-button><n-button type="primary" :loading="prompt.busy" :disabled="!prompt.value.trim()" @click="submitPrompt">{{ prompt.confirm }}</n-button></div>
      </template>
    </n-modal>
  </div>
</template>

<script setup>
import { computed, h, nextTick, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import {
  NBreadcrumb, NBreadcrumbItem, NButton, NButtonGroup, NCheckbox, NDataTable, NDropdown, NEmpty, NIcon, NInput,
  NModal, NResult, NSpin,
} from 'naive-ui'
import {
  AddOutline, ArchiveOutline, ArrowBackOutline, CloudUploadOutline, CopyOutline, CreateOutline, DocumentTextOutline,
  DownloadOutline, EllipsisHorizontal, EyeOffOutline, EyeOutline, FolderOpenOutline, GridOutline, HomeOutline, ListOutline,
  RefreshOutline, ReturnUpForwardOutline, SearchOutline, TrashOutline, FolderOutline, EyeOutline as ViewIcon, ExpandOutline,
} from '@vicons/ionicons5'
import { api } from '../api'
import { useFeedback } from '../composables'
import { useAppStore } from '../store'
import { collectDropped, fromInput } from '../upload-utils'
import { baseName, extOf, formatBytes, formatDate, isImage, joinPath, kindOf, parentPath } from '../utils'
import FileIcon from './FileIcon.vue'
import FolderPicker from './FolderPicker.vue'
import PreviewModal from './PreviewModal.vue'
import SearchModal from './SearchModal.vue'
import UploadPanel from './UploadPanel.vue'

const props = defineProps({ space: { type: String, required: true }, emptyText: { type: String, default: '' } })
const { t } = useI18n()
const app = useAppStore()
const route = useRoute()
const router = useRouter()
const fb = useFeedback()

const can = p => app.can(props.space, p)
const location = computed(() => {
  const q = route.query.path
  return typeof q === 'string' && q.startsWith('/') ? q : '/'
})

const items = ref([])
const loading = ref(false)
const error = ref('')
const checked = ref([])
const showHidden = ref(false)
const searchOpen = ref(false)
const gridLimit = ref(120)
const sortKey = ref('name')
const sortOrder = ref('ascend')
const dragging = ref(false)
let dragDepth = 0
const uploader = ref(null)
const fileInput = ref(null)
const folderInput = ref(null)
const promptInput = ref(null)

const preview = reactive({ show: false, item: null })
const picker = reactive({ show: false, mode: 'copy', items: [], title: '', confirm: '' })
const ctx = reactive({ show: false, x: 0, y: 0, item: null, options: [] })
const prompt = reactive({ show: false, title: '', label: '', value: '', confirm: '', busy: false, action: null })

const selectable = computed(() => can('write') || can('zip') || (can('download') && can('batchdownload')))
const visible = computed(() => (showHidden.value ? items.value : items.value.filter(i => !i.name.startsWith('.'))))
const hiddenCount = computed(() => items.value.length - items.value.filter(i => !i.name.startsWith('.')).length)
const selected = computed(() => items.value.filter(i => checked.value.includes(i.path)))
const crumbs = computed(() => {
  const out = [{ name: t('common.home'), path: '/' }]
  let acc = ''
  for (const part of location.value.split('/').filter(Boolean)) { acc += `/${part}`; out.push({ name: part, path: acc }) }
  return out
})

const sorted = computed(() => {
  const dir = sortOrder.value === 'descend' ? -1 : 1
  const key = sortKey.value
  return [...visible.value].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
    if (key === 'size') return (a.size - b.size) * dir || a.name.localeCompare(b.name)
    if (key === 'mtime') return (a.mtime - b.mtime) * dir
    return a.name.localeCompare(b.name, 'th', { numeric: true }) * dir
  })
})
const gridItems = computed(() => sorted.value.slice(0, gridLimit.value))

function onSorter(s) {
  if (!s || !s.order) { sortKey.value = 'name'; sortOrder.value = 'ascend' } else { sortKey.value = s.columnKey; sortOrder.value = s.order }
}

async function load(quiet = false) {
  if (!quiet) loading.value = true
  error.value = ''
  try {
    const res = await api.list(props.space, location.value)
    items.value = res.entries
    checked.value = checked.value.filter(p => res.entries.some(e => e.path === p))
  } catch (e) {
    if (e.status === 404 && location.value !== '/') return go('/', true)
    items.value = []
    error.value = e.message
  } finally {
    loading.value = false
  }
}

function go(path, replace = false) {
  checked.value = []
  gridLimit.value = 120
  const target = { query: path === '/' ? {} : { path } }
  return replace ? router.replace(target) : router.push(target)
}

watch(() => [props.space, location.value], () => { items.value = []; load() }, { immediate: true })

// ───── opening & downloading ─────
function triggerDownload(url) {
  const a = document.createElement('a')
  a.href = url
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
}

function open(it) {
  if (it.type === 'dir') return go(it.path)
  if (kindOf(it.name) !== 'other' && can('download')) { preview.item = it; preview.show = true; return }
  if (can('download')) triggerDownload(api.downloadUrl(props.space, it.path))
}

async function downloadMany(list) {
  try {
    const { token } = await api.batch(props.space, location.value, list.map(i => i.name))
    triggerDownload(api.batchUrl(token))
    fb.ok(t('files.batchReady'))
  } catch (e) { fb.fail(e) }
}

// ───── prompts (rename, new folder, zip) ─────
function ask({ title, label, value = '', confirm, action }) {
  Object.assign(prompt, { show: true, title, label, value, confirm: confirm || t('common.confirm'), action, busy: false })
  nextTick(() => { promptInput.value?.focus(); promptInput.value?.select?.() })
}
async function submitPrompt() {
  const value = prompt.value.trim()
  if (!value || prompt.busy) return
  prompt.busy = true
  try { await prompt.action(value); prompt.show = false } catch (e) { fb.fail(e) } finally { prompt.busy = false }
}

const createOptions = computed(() => [
  { key: 'folder', label: t('files.newFolder'), icon: () => h(NIcon, { component: FolderOutline }) },
  { key: 'file', label: t('files.newFile'), icon: () => h(NIcon, { component: DocumentTextOutline }) },
])
function onCreateSelect(k) {
  if (k === 'folder') ask({ title: t('files.newFolder'), label: t('files.folderName'), confirm: t('common.create'), action: async name => { await api.mkdir(props.space, location.value, name); await load(true) } })
  else ask({ title: t('files.newFile'), label: t('files.fileName'), value: 'untitled.txt', confirm: t('common.create'), action: async name => { await api.newFile(props.space, location.value, name); await load(true) } })
}

function rename(it) {
  ask({ title: t('common.rename'), label: t('files.newName'), value: it.name, confirm: t('common.rename'), action: async name => { await api.rename(props.space, it.path, name); await load(true) } })
}

function askZip(list) {
  const base = list.length === 1 ? list[0].name.replace(/\.[^.]+$/, '') : baseName(location.value) || 'archive'
  ask({ title: t('files.zip'), label: t('files.archiveName'), value: `${base}.zip`, confirm: t('files.zip'), action: async name => {
    await api.zip(props.space, location.value, list.map(i => i.name), name)
    fb.ok(t('files.done'))
    checked.value = []
    await load(true)
  } })
}

async function unzip(it) {
  if (!(await fb.confirm({ title: t('files.unzip'), content: t('files.unzipConfirm', { name: it.name }) }))) return
  try { await api.unzip(props.space, it.path); fb.ok(t('files.done')); await load(true) } catch (e) { fb.fail(e) }
}

async function remove(list) {
  const content = `${t('files.deleteConfirm', { n: list.length })} ${t('files.deleteToTrash', { days: app.config.trashRetentionDays })}`
  if (!(await fb.confirm({ title: t('common.delete'), content, positive: t('common.delete'), danger: true }))) return
  try {
    const r = await api.remove(props.space, list.map(i => i.path))
    r.failed.length ? fb.warn(t('files.partial', { ok: r.done, failed: r.failed.length, reason: r.failed[0].error })) : fb.ok(t('files.done'))
    checked.value = []
    await load(true)
  } catch (e) { fb.fail(e) }
}

// ───── copy / move ─────
function pick(mode, list) {
  Object.assign(picker, { show: true, mode, items: list.map(i => i.path), title: mode === 'copy' ? t('files.copyTo') : t('files.moveTo'), confirm: mode === 'copy' ? t('files.copyHere') : t('files.moveHere') })
}
async function onPicked2(dest) {
  try {
    const r = await (picker.mode === 'copy' ? api.copy : api.move)(props.space, picker.items, dest)
    r.failed.length ? fb.warn(t('files.partial', { ok: r.done, failed: r.failed.length, reason: r.failed[0].error })) : fb.ok(t('files.done'))
    checked.value = []
    await load(true)
  } catch (e) { fb.fail(e) }
}

// ───── actions menu ─────
const ico = c => () => h(NIcon, { component: c })
function actionsFor(it) {
  const list = []
  const isZip = it.type === 'file' && extOf(it.name) === 'zip'
  if (it.type === 'dir') list.push({ key: 'open', label: t('common.open'), icon: ico(FolderOpenOutline) })
  else if (kindOf(it.name) !== 'other' && can('download')) list.push({ key: 'open', label: t('files.preview'), icon: ico(ViewIcon) })
  if (it.type === 'file' && can('download')) list.push({ key: 'download', label: t('common.download'), icon: ico(DownloadOutline) })
  if (it.type === 'dir' && can('download') && can('batchdownload')) list.push({ key: 'download', label: t('files.downloadZip'), icon: ico(DownloadOutline) })
  if (can('write')) {
    list.push({ key: 'rename', label: t('common.rename'), icon: ico(CreateOutline) })
    list.push({ key: 'copy', label: t('files.copyTo'), icon: ico(CopyOutline) })
    list.push({ key: 'move', label: t('files.moveTo'), icon: ico(ReturnUpForwardOutline) })
  }
  if (can('zip') && can('write')) {
    list.push({ key: 'zip', label: t('files.zip'), icon: ico(ArchiveOutline) })
    if (isZip) list.push({ key: 'unzip', label: t('files.unzip'), icon: ico(ExpandOutline) })
  }
  if (can('write')) list.push({ type: 'divider', key: 'd' }, { key: 'delete', label: t('common.delete'), icon: ico(TrashOutline) })
  return list
}

function run(key, it) {
  if (key === 'open') return open(it)
  if (key === 'download') return it.type === 'dir' ? downloadMany([it]) : triggerDownload(api.downloadUrl(props.space, it.path))
  if (key === 'rename') return rename(it)
  if (key === 'copy') return pick('copy', [it])
  if (key === 'move') return pick('move', [it])
  if (key === 'zip') return askZip([it])
  if (key === 'unzip') return unzip(it)
  if (key === 'delete') return remove([it])
}

function openContext(e, it) {
  const options = actionsFor(it)
  if (!options.length) return
  Object.assign(ctx, { show: false, item: it, options, x: e.clientX, y: e.clientY })
  nextTick(() => { ctx.show = true })
}

function toggle(it, on) {
  checked.value = on ? [...new Set([...checked.value, it.path])] : checked.value.filter(p => p !== it.path)
}

// ───── list view ─────
const columns = computed(() => {
  const cols = []
  if (selectable.value) cols.push({ type: 'selection', width: 44 })
  cols.push(
    {
      title: t('common.name'), key: 'name', minWidth: 220, sorter: true,
      sortOrder: sortKey.value === 'name' ? sortOrder.value : false,
      render: row => h('button', { type: 'button', class: 'name-cell', onClick: () => open(row) }, [
        h(FileIcon, { item: row, size: 22 }),
        h('span', { class: 'truncate name-text', title: row.name }, row.name),
      ]),
    },
    {
      title: t('common.size'), key: 'size', width: 110, sorter: true,
      sortOrder: sortKey.value === 'size' ? sortOrder.value : false,
      render: row => (row.type === 'dir' ? '—' : formatBytes(row.size)),
    },
    {
      title: t('common.modified'), key: 'mtime', width: 160, sorter: true,
      sortOrder: sortKey.value === 'mtime' ? sortOrder.value : false,
      render: row => formatDate(row.mtime),
    },
    {
      title: '', key: 'actions', width: 56, align: 'right',
      render: row => {
        const options = actionsFor(row)
        return options.length
          ? h(NDropdown, { trigger: 'click', placement: 'bottom-end', options, onSelect: k => run(k, row) }, {
              default: () => h(NButton, { quaternary: true, circle: true, size: 'small' }, { icon: () => h(NIcon, { component: EllipsisHorizontal }) }),
            })
          : null
      },
    },
  )
  return cols
})
const rowProps = row => ({ onContextmenu: e => { e.preventDefault(); openContext(e, row) } })

// ───── upload ─────
const uploadOptions = computed(() => [
  { key: 'files', label: t('files.uploadFiles'), icon: ico(DocumentTextOutline) },
  { key: 'folder', label: t('files.uploadFolder'), icon: ico(FolderOutline) },
])
const onUploadSelect = k => pickFiles(k === 'folder')
function pickFiles(folder) { (folder ? folderInput : fileInput).value?.click() }
function onPicked(e) {
  const list = fromInput(e.target.files)
  e.target.value = ''
  if (list.length) uploader.value?.add(list, location.value)
}

const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files')
function onDragEnter(e) { if (can('upload') && hasFiles(e)) { dragDepth++; dragging.value = true } }
function onDragLeave() { if (dragging.value && --dragDepth <= 0) { dragging.value = false; dragDepth = 0 } }
function onDrop(e) {
  dragging.value = false
  dragDepth = 0
  if (!can('upload') || !hasFiles(e)) return
  collectDropped(e.dataTransfer).then(list => list.length && uploader.value?.add(list, location.value))
}

function onSearchSelect(it) {
  if (it.type === 'dir') return go(it.path)
  const dir = parentPath(it.path)
  const finish = () => { preview.item = it; preview.show = kindOf(it.name) !== 'other' && can('download') }
  if (dir === location.value) return finish()
  go(dir).then(() => setTimeout(finish, 250))
}
</script>

<style scoped>
.browser { position: relative; }
.toolbar { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; }
.left, .right { display: flex; align-items: center; gap: 8px; }
.crumbs { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; min-height: 28px; flex-wrap: wrap; }
.crumb { display: inline-flex; align-items: center; gap: 4px; cursor: pointer; }
.count { margin-left: auto; font-size: 13px; }
.selection { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; padding: 8px 14px; margin-bottom: 12px; border-radius: var(--radius); background: var(--primary-soft); border: 1px solid color-mix(in srgb, var(--primary) 30%, transparent); }
.sel-count { font-weight: 600; color: var(--primary); }
.sel-actions { display: flex; gap: 6px; flex-wrap: wrap; }
.content { overflow: hidden; min-height: 220px; }
.empty { padding: 56px 16px; }
.small { font-size: 13px; margin: 0 0 12px; }
.hidden-note { padding: 10px 16px; font-size: 13px; border-top: 1px solid var(--border); }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 12px; padding: 16px; }
.card { position: relative; border: 1px solid var(--border); border-radius: 10px; background: var(--surface-2); transition: border-color 0.15s, box-shadow 0.15s; }
.card:hover { border-color: var(--primary); }
.card.on { border-color: var(--primary); box-shadow: 0 0 0 2px var(--primary-soft); }
.card-main { all: unset; box-sizing: border-box; display: block; width: 100%; cursor: pointer; padding: 10px; }
.thumb { height: 104px; border-radius: 8px; display: grid; place-items: center; overflow: hidden; background: var(--surface); }
.thumb img { width: 100%; height: 100%; object-fit: cover; }
.card-name { margin-top: 8px; font-size: 13.5px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.card-meta { font-size: 12px; }
.card-check { position: absolute; top: 14px; left: 14px; }
.card-menu { position: absolute; top: 12px; right: 12px; background: var(--surface); }
.more { grid-column: 1 / -1; text-align: center; }
.drop { position: fixed; inset: 0; z-index: 100; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; background: color-mix(in srgb, var(--primary) 14%, transparent); border: 3px dashed var(--primary); color: var(--primary); font-size: 18px; font-weight: 600; pointer-events: none; }
.foot { display: flex; justify-content: flex-end; gap: 8px; }
.fade-enter-active, .fade-leave-active { transition: opacity 0.15s; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
:deep(.name-cell) { all: unset; display: flex; align-items: center; gap: 10px; cursor: pointer; max-width: 100%; }
:deep(.name-cell:hover .name-text) { color: var(--primary); text-decoration: underline; }
:deep(.name-text) { min-width: 0; }
</style>
