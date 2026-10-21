<template>
  <div ref="root" class="browser" @dragenter="onDragEnter" @dragover="onDragOver" @dragleave="onDragLeave" @drop.prevent="onDrop" @contextmenu="onBlankContext">
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
        <n-button class="keys-btn" quaternary circle :title="`${t('files.shortcuts')} (?)`" :aria-label="t('files.shortcuts')" @click="keysOpen = true"><template #icon><n-icon :component="KeypadOutline" /></template></n-button>
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
          <span
            class="crumb" :class="{ 'drop-on': dropKey === c.path }"
            @dragover="dropOver($event, c.path)" @dragleave="dropLeave($event, c.path)" @drop="dropDo($event, c.path)"
          ><n-icon v-if="c.path === '/'" :component="HomeOutline" />{{ c.name }}</span>
        </n-breadcrumb-item>
      </n-breadcrumb>
      <span class="count muted">{{ t('files.itemCount', { n: visible.length }) }}</span>
    </div>

    <!-- storage use: only in the personal folder of an account with a quota -->
    <div v-if="usage && usage.quota > 0" class="usage">
      <n-progress type="line" :percentage="usagePct" :status="usagePct >= 100 ? 'error' : usagePct >= 90 ? 'warning' : 'default'" :show-indicator="false" :height="6" />
      <div class="muted small">{{ t('security.usedOf', { used: formatBytes(usage.used), quota: formatBytes(usage.quota) }) }} ({{ usagePct }}%)</div>
    </div>

    <!-- what Ctrl+C / Ctrl+X took: it waits for a paste in any folder of this space -->
    <div v-if="clip && clip.paths.length" class="clip" role="status">
      <n-icon :component="clip.mode === 'cut' ? CutOutline : CopyOutline" />
      <span class="clip-text" :title="t('files.clipTip')">{{ t(clip.mode === 'cut' ? 'files.clipCut' : 'files.clipCopy', { n: clip.paths.length }) }}</span>
      <n-button v-if="can('write')" size="tiny" secondary type="primary" @click="paste"><template #icon><n-icon :component="ClipboardOutline" /></template>{{ t('files.clipPaste') }}</n-button>
      <n-button size="tiny" quaternary @click="clip = null">{{ t('files.clipClear') }}</n-button>
    </div>

    <transition name="fade">
      <div v-if="selected.length" class="selection">
        <span class="sel-count">{{ t('files.selected', { n: selected.length }) }}</span>
        <div class="sel-actions">
          <n-button v-if="can('download') && can('batchdownload')" size="small" secondary @click="downloadMany(selected)"><template #icon><n-icon :component="DownloadOutline" /></template>{{ t('common.download') }}</n-button>
          <n-button v-if="selected.length === 1 && canShareItem(selected[0])" size="small" secondary @click="openShare(selected[0])"><template #icon><n-icon :component="LinkOutline" /></template>{{ t('share.action') }}</n-button>
          <n-button v-if="can('write') || copyOut" size="small" secondary @click="pick('copy', selected)"><template #icon><n-icon :component="CopyOutline" /></template>{{ t('files.copyTo') }}</n-button>
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
          :row-props="rowProps" :row-class-name="rowClass" :pagination="pagination"
          :bordered="false" :single-line="false" :scroll-x="620"
          @update:checked-row-keys="k => (checked = k)" @update:sorter="onSorter"
        />
        <div v-else class="grid">
          <div
            v-for="it in gridItems" :key="it.path" class="card" :data-path="it.path" :draggable="can('write')"
            :class="{ on: checked.includes(it.path), cursor: cursor === it.path, 'drop-on': dropKey === it.path }"
            @contextmenu.prevent.stop="openContext($event, it)" @click="cursor = it.path"
            @dragstart="dragStart($event, it)" @dragend="dragEnd"
            @dragover="it.type === 'dir' && dropOver($event, it.path)" @dragleave="it.type === 'dir' && dropLeave($event, it.path)" @drop="it.type === 'dir' && dropDo($event, it.path)"
          >
            <button type="button" class="card-main" @click="open(it)">
              <div class="thumb">
                <img v-if="hasThumb(it)" :src="api.downloadUrl(space, it.path, true)" loading="lazy" :alt="it.name">
                <file-icon v-else :item="it" :size="44" />
              </div>
              <div class="card-name" :title="it.name">{{ it.name }}</div>
              <div class="card-meta muted">{{ it.type === 'dir' ? t('common.folder') : formatBytes(it.size) }}</div>
            </button>
            <n-checkbox v-if="selectable" class="card-check" :checked="checked.includes(it.path)" @update:checked="v => toggle(it, v)" />
            <n-button v-if="starrable" class="card-star" quaternary circle size="small" :title="isFav(it) ? t('files.removeFavorite') : t('files.addFavorite')" @click="toggleFav(it)">
              <template #icon><n-icon :component="isFav(it) ? Star : StarOutline" :color="isFav(it) ? '#f59e0b' : undefined" /></template>
            </n-button>
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

    <n-dropdown placement="bottom-start" trigger="manual" :x="ctx.x" :y="ctx.y" :options="ctx.options" :show="ctx.show" :on-clickoutside="() => (ctx.show = false)" @select="k => { ctx.show = false; ctx.item ? run(k, ctx.item) : runBlank(k) }" />

    <input ref="fileInput" type="file" multiple hidden @change="onPicked">
    <input ref="folderInput" type="file" webkitdirectory hidden @change="onPicked">

    <upload-panel v-if="can('upload')" ref="uploader" :space="space" @uploaded="load(true)" />
    <search-modal v-model:show="searchOpen" :space="space" :start="location" @select="onSearchSelect" />
    <folder-picker v-model:show="picker.show" :space="space" :spaces="destSpaces" :title="picker.title" :confirm-text="picker.confirm" :initial="location" @select="onPicked2" />
    <versions-modal v-model:show="versions.show" :space="space" :item="versions.item" :can-write="can('write')" :can-download="can('download')" @restored="onRestored" />
    <share-modal v-if="canShare" v-model:show="share.show" :space="space" :item="share.item" />
    <grant-modal v-if="canGrant" v-model:show="grant.show" :item="grant.item" />

    <n-modal v-model:show="keysOpen" preset="card" :title="t('keys.title')" style="width: min(520px, 94vw)">
      <p class="muted keys-hint">{{ t('keys.hint') }}</p>
      <dl class="keys">
        <template v-for="k in shortcutList" :key="k.keys">
          <dt><template v-for="(part, i) in k.keys.split('+')" :key="part"><span v-if="i" class="plus">+</span><kbd>{{ part }}</kbd></template></dt>
          <dd>{{ t(`keys.${k.text}`) }}</dd>
        </template>
      </dl>
      <p v-if="can('write')" class="muted keys-hint">{{ t('keys.drag') }}</p>
      <template #footer><div class="foot"><n-button @click="keysOpen = false">{{ t('common.close') }}</n-button></div></template>
    </n-modal>
    <preview-modal v-model:show="preview.show" :space="space" :item="preview.item" :siblings="visible" :can-edit="can('write')" :can-download="can('download')" :office-mode-of="officeModeOf" @saved="load(true)" @office="openOffice" @versions="openVersions" />
    <office-editor v-model:show="office.show" :space="space" :item="office.item" :mode="office.mode" @closed="onOfficeClosed" />

    <n-modal v-model:show="prompt.show" preset="card" :title="prompt.title" style="width: min(440px, 94vw)">
      <n-input ref="promptInput" v-model:value="prompt.value" :placeholder="prompt.label" @keyup.enter="submitPrompt" />
      <template #footer>
        <div class="foot"><n-button @click="prompt.show = false">{{ t('common.cancel') }}</n-button><n-button type="primary" :loading="prompt.busy" :disabled="!prompt.value.trim()" @click="submitPrompt">{{ prompt.confirm }}</n-button></div>
      </template>
    </n-modal>
  </div>
</template>

<script setup>
import { computed, h, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import {
  NBreadcrumb, NBreadcrumbItem, NButton, NButtonGroup, NCheckbox, NDataTable, NDropdown, NEmpty, NIcon, NInput,
  NModal, NProgress, NResult, NSpin,
} from 'naive-ui'
import {
  AddOutline, ArchiveOutline, ArrowBackOutline, ClipboardOutline, CloudUploadOutline, CopyOutline, CreateOutline, CutOutline, DocumentTextOutline,
  DownloadOutline, EllipsisHorizontal, EyeOffOutline, EyeOutline, FolderOpenOutline, GridOutline, HomeOutline, KeypadOutline, LinkOutline, ListOutline, PeopleOutline,
  OpenOutline, RefreshOutline, ReturnUpForwardOutline, SearchOutline, Star, StarOutline, TimeOutline, TrashOutline, FolderOutline, EyeOutline as ViewIcon, ExpandOutline,
} from '@vicons/ionicons5'
import { api } from '../api'
import { useFeedback } from '../composables'
import { useAppStore } from '../store'
import { collectDropped, fromInput } from '../upload-utils'
import { baseName, extOf, formatBytes, formatDate, isImage, joinPath, kindOf, officeModeFor, parentPath } from '../utils'
import FileIcon from './FileIcon.vue'
import FolderPicker from './FolderPicker.vue'
import GrantModal from './GrantModal.vue'
import OfficeEditor from './OfficeEditor.vue'
import PreviewModal from './PreviewModal.vue'
import SearchModal from './SearchModal.vue'
import ShareModal from './ShareModal.vue'
import UploadPanel from './UploadPanel.vue'
import VersionsModal from './VersionsModal.vue'

const props = defineProps({ space: { type: String, required: true }, emptyText: { type: String, default: '' } })
const { t, locale } = useI18n()
const app = useAppStore()
const route = useRoute()
const router = useRouter()
const fb = useFeedback()

// a managed user's folder (`user:<name>`) is looked at, never changed; a folder another user shares (`grant:<id>`) may
// be changed when it was shared for editing. The session knows neither: the rights come with each listing. Nothing
// else here may offer a write
const viewing = computed(() => props.space.startsWith('user:') || props.space.startsWith('grant:') || props.space.startsWith('group:'))
const inGrant = computed(() => props.space.startsWith('grant:'))
const viewPerms = ref([])
const can = p => (viewing.value ? viewPerms.value.includes(p) : app.can(props.space, p))
// signed in with `share` and `download` here (visitors of the public page never make links)
// (a request link needs `upload` instead of `download`, and only a folder can receive files)
const canShare = computed(() => !!app.user && can('share') && (can('download') || can('upload')))
const canShareItem = it => canShare.value && (can('download') || (it.type === 'dir' && can('upload')))
// a folder of the personal space to another user needs `share` alone (the server's rule for POST /api/grants)
const canGrant = computed(() => !!app.user && props.space === 'home' && can('share'))
// the grid shows the original picture as its thumbnail, so leave out the big ones
const THUMB_MAX = 5 * 1024 * 1024
const hasThumb = it => it.type === 'file' && isImage(it.name) && it.size <= THUMB_MAX && can('download')
const location = computed(() => {
  const q = route.query.path
  return typeof q === 'string' && q.startsWith('/') ? q : '/'
})

const items = ref([])
const loading = ref(false)
// kept here, not written inline in the template: an inline object is made anew on every render, so the size picker
// and the page buttons had nothing to change
const pagination = reactive({
  page: 1, pageSize: 50, showSizePicker: true, pageSizes: [25, 50, 100, 200],
  onUpdatePage: p => { pagination.page = p },
  onUpdatePageSize: s => { pagination.pageSize = s; pagination.page = 1 },
})
const error = ref('')
const checked = ref([])
const showHidden = ref(false)
const searchOpen = ref(false)
const gridLimit = ref(120)
const sortKey = ref('name')
const sortOrder = ref('ascend')
const dragging = ref(false)
let dragDepth = 0
const root = ref(null)
const keysOpen = ref(false)
/** the row the arrow keys are on, and where a Shift+arrow range started */
const cursor = ref('')
let anchor = ''
/** what Ctrl+C / Ctrl+X took: { mode: 'copy' | 'cut', paths } of this space (it may be pasted in any folder of it) */
const clip = ref(null)
const uploader = ref(null)
const fileInput = ref(null)
const folderInput = ref(null)
const promptInput = ref(null)

const preview = reactive({ show: false, item: null })
const office = reactive({ show: false, item: null, mode: 'view' })
/** stops waiting for the office editor's save (see onOfficeClosed) */
let officeWait = null
const share = reactive({ show: false, item: null })
const grant = reactive({ show: false, item: null })
const versions = reactive({ show: false, item: null })
const picker = reactive({ show: false, mode: 'copy', items: [], title: '', confirm: '' })
const ctx = reactive({ show: false, x: 0, y: 0, item: null, options: [] })
const prompt = reactive({ show: false, title: '', label: '', value: '', confirm: '', busy: false, action: null })

const selectable = computed(() => can('write') || can('zip') || copyOut.value || (can('download') && can('batchdownload')))
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

const usage = ref(null)
const usagePct = computed(() => (usage.value?.quota ? Math.min(100, Math.round((usage.value.used / usage.value.quota) * 100)) : 0))
async function loadUsage() {
  if (props.space !== 'home' || !app.user) return
  try { usage.value = await api.usage() } catch { /* the line is a nicety */ }
}

async function load(quiet = false) {
  if (!quiet) loading.value = true
  error.value = ''
  loadUsage()
  app.loadFavorites()
  try {
    const res = await api.list(props.space, location.value)
    items.value = res.entries
    if (viewing.value) viewPerms.value = res.permissions || []
    checked.value = checked.value.filter(p => res.entries.some(e => e.path === p))
    applySelect()
  } catch (e) {
    // an old bookmark or a typed address: say why the page shows the top folder instead
    if (e.status === 404 && location.value !== '/') {
      fb.warn(t('files.folderNotFound', { path: location.value }))
      return go('/', true)
    }
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

watch(() => [props.space, location.value], () => { items.value = []; if (!viewing.value) viewPerms.value = []; pagination.page = 1; cursor.value = ''; anchor = ''; office.show = false; officeWait?.(); load() }, { immediate: true })
// a cut or copy is of one space: it can not be pasted into another
watch(() => props.space, () => { clip.value = null })
// a folder that could not be read shows the server's text: read it again so the text follows the language switch
watch(locale, () => { if (error.value) load(true) })

// a link from Favorites / Recent: ?select=<path> marks that file (and opens its preview), then the address is cleaned
function applySelect() {
  const want = route.query.select
  if (typeof want !== 'string') return
  const it = items.value.find(e => e.path === want)
  const { select, ...rest } = route.query
  router.replace({ query: rest })
  if (!it) return
  if (selectable.value) checked.value = [it.path]
  if (it.type === 'file' && kindOf(it.name) !== 'other' && can('download')) { preview.item = it; preview.show = true }
}

// ───── favorites ─────
const starrable = computed(() => !!app.user && !viewing.value)
const isFav = it => app.isFavorite(props.space, it.path)
async function toggleFav(it) {
  try { await app.toggleFavorite(props.space, it.path) } catch (e) { fb.fail(e) }
}

// ───── previous versions ─────
function openVersions(it) {
  versions.item = it
  versions.show = true
}
/** a restore changed the file: read the folder again, and an open preview of it starts over with the restored text */
async function onRestored(it) {
  await load(true)
  const fresh = items.value.find(e => e.path === it.path)
  if (fresh && preview.show) preview.item = fresh
}

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
  // no viewer in the page (doc, xls, ppt ...): the office editor reads it when it is set up
  const mode = officeModeOf(it.name)
  if (mode) return openOffice(it, mode)
  if (can('download')) triggerDownload(api.downloadUrl(props.space, it.path))
}

// ───── ONLYOFFICE ─────
const officeModeOf = name => (viewing.value ? null : officeModeFor(app.config.office, can, name))
function openOffice(it, mode) {
  Object.assign(office, { item: it, mode, show: true })
}
/**
 * The document server hands the saved file over a few seconds after the editor closes: say so, and read the
 * folder again until the file has changed (or give up after half a minute; the next refresh shows it).
 */
async function onOfficeClosed({ item, edited }) {
  await load(true)
  if (!edited) return
  // closing another file meanwhile: only the newest wait goes on
  officeWait?.()
  const done = fb.busy(t('office.saving', { name: item.name }))
  let stopped = false
  const stop = () => { stopped = true; done(); if (officeWait === stop) officeWait = null }
  officeWait = stop
  for (let i = 0; i < 15; i++) {
    await new Promise(r => setTimeout(r, 2000))
    if (stopped) return
    await load(true)
    if (stopped) return
    const now = items.value.find(e => e.path === item.path)
    if (now && now.mtime !== item.mtime) {
      stop()
      return fb.ok(t('office.saved', { name: item.name }))
    }
  }
  stop()
  fb.warn(t('office.savePending', { name: item.name }))
}
onBeforeUnmount(() => officeWait?.())

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
    const r = await api.remove(props.space, list.map(i => i.path), true)
    if (r.failed.length) fb.warn(t('files.partial', { ok: r.done, failed: r.failed.length, reason: r.failed[0].error }))
    // the message stays a few seconds with a way back: the trash entry of each item is restored
    else if (r.trashed?.length) fb.undo(t('files.deletedN', { n: r.done }), t('files.undo'), () => undoDelete(r.trashed))
    else fb.ok(t('files.done'))
    checked.value = []
    cursor.value = ''
    await load(true)
  } catch (e) { fb.fail(e) }
}
async function undoDelete(trashed) {
  let ok = 0
  let firstError = null
  for (const x of trashed) {
    try { await api.restoreMine(x.id); ok++ } catch (e) { firstError ??= e }
  }
  if (firstError) fb.warn(ok ? t('files.partial', { ok, failed: trashed.length - ok, reason: firstError.message }) : firstError.message)
  else fb.ok(t('files.undone', { n: ok }))
  await load(true)
}

// ───── copy / move ─────
function pick(mode, list) {
  Object.assign(picker, { show: true, mode, items: list.map(i => i.path), title: mode === 'copy' ? t('files.copyTo') : t('files.moveTo'), confirm: mode === 'copy' ? t('files.copyHere') : t('files.moveHere') })
}
/** where a copy or move may go: here, and another space only with write and upload there (the server checks again) */
// another space where the user may put files: a copy out of this one needs only read + download here (the server's rule)
const otherDest = s => s !== props.space && app.can(s, 'write') && app.can(s, 'upload')
// (a managed user's folder is never copied out of: the server refuses it; a folder shared with the user may be)
const copyOut = computed(() => !props.space.startsWith('user:') && can('read') && can('download') && ['home', 'public'].some(otherDest))
const destSpaces = computed(() => {
  const label = s => (s === 'public' ? t('nav.publicFolder') : s === 'home' ? t('nav.files') : t('grants.sharedFolder'))
  // the folder shared with the user is a place to put things too, when it was shared for editing
  return [...(inGrant.value ? [props.space] : []), 'home', 'public']
    .filter(s => (s === props.space && can('write')) || otherDest(s))
    .map(s => ({ value: s, label: label(s) }))
})
async function onPicked2(dest, destSpace) {
  try {
    const r = await (picker.mode === 'copy' ? api.copy : api.move)(props.space, picker.items, dest, destSpace && destSpace !== props.space ? destSpace : undefined)
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
  const officeMode = it.type === 'file' ? officeModeOf(it.name) : null
  if (officeMode) list.push({ key: 'office', label: officeMode === 'edit' ? t('office.edit') : t('office.open'), icon: ico(officeMode === 'edit' ? CreateOutline : OpenOutline) })
  if (it.type === 'file' && can('read')) list.push({ key: 'versions', label: t('versions.menu'), icon: ico(TimeOutline) })
  if (starrable.value) list.push({ key: 'star', label: isFav(it) ? t('files.removeFavorite') : t('files.addFavorite'), icon: ico(isFav(it) ? Star : StarOutline) })
  if (it.type === 'file' && can('download')) list.push({ key: 'download', label: t('common.download'), icon: ico(DownloadOutline) })
  if (it.type === 'dir' && can('download') && can('batchdownload')) list.push({ key: 'download', label: t('files.downloadZip'), icon: ico(DownloadOutline) })
  if (canShareItem(it)) list.push({ key: 'share', label: t('share.action'), icon: ico(LinkOutline) })
  if (it.type === 'dir' && canGrant.value) list.push({ key: 'grant', label: t('grants.shareAction'), icon: ico(PeopleOutline) })
  if (can('write')) {
    list.push({ key: 'rename', label: t('common.rename'), icon: ico(CreateOutline) })
    list.push({ key: 'copy', label: t('files.copyTo'), icon: ico(CopyOutline) })
    list.push({ key: 'move', label: t('files.moveTo'), icon: ico(ReturnUpForwardOutline) })
  }
  else if (copyOut.value) list.push({ key: 'copy', label: t('files.copyTo'), icon: ico(CopyOutline) })
  if (can('zip') && can('write')) {
    list.push({ key: 'zip', label: t('files.zip'), icon: ico(ArchiveOutline) })
    if (isZip) list.push({ key: 'unzip', label: t('files.unzip'), icon: ico(ExpandOutline) })
  }
  if (can('write')) list.push({ type: 'divider', key: 'd' }, { key: 'delete', label: t('common.delete'), icon: ico(TrashOutline) })
  return list
}

function run(key, it) {
  if (key === 'open') return open(it)
  if (key === 'office') return openOffice(it, officeModeOf(it.name))
  if (key === 'download') return it.type === 'dir' ? downloadMany([it]) : triggerDownload(api.downloadUrl(props.space, it.path))
  if (key === 'versions') return openVersions(it)
  if (key === 'star') return toggleFav(it)
  if (key === 'share') return openShare(it)
  if (key === 'grant') { grant.item = it; grant.show = true; return }
  if (key === 'rename') return rename(it)
  if (key === 'copy') return pick('copy', [it])
  if (key === 'move') return pick('move', [it])
  if (key === 'zip') return askZip([it])
  if (key === 'unzip') return unzip(it)
  if (key === 'delete') return remove([it])
}

function openShare(it) {
  share.item = it
  share.show = true
}

function openContext(e, it) {
  const options = actionsFor(it)
  if (!options.length) return
  cursor.value = it.path
  Object.assign(ctx, { show: false, item: it, options, x: e.clientX, y: e.clientY })
  nextTick(() => { ctx.show = true })
}

// right-click on empty space: what can be done to the folder itself
function blankActions() {
  const list = []
  if (can('write')) {
    list.push({ key: 'folder', label: t('files.newFolder'), icon: ico(FolderOutline) })
    list.push({ key: 'file', label: t('files.newFile'), icon: ico(DocumentTextOutline) })
  }
  if (can('upload')) {
    list.push({ key: 'upload-files', label: t('files.uploadFiles'), icon: ico(CloudUploadOutline) })
    list.push({ key: 'upload-folder', label: t('files.uploadFolder'), icon: ico(FolderOutline) })
  }
  if (clip.value?.paths.length && can('write')) list.push({ type: 'divider', key: 'd' }, { key: 'paste', label: `${t('files.clipPaste')} (${clip.value.paths.length})`, icon: ico(ClipboardOutline) })
  return list
}
function onBlankContext(e) {
  // a row, a text box, a link, the pagination or the column titles keep their own menu or none
  if (e.defaultPrevented || e.target.closest?.('input, textarea, a, button, .toolbar, .crumbs, .selection, .clip, .usage, .n-pagination, .n-data-table-thead, .card, .n-data-table-tr')) return
  const options = blankActions()
  if (!options.length) return
  e.preventDefault()
  Object.assign(ctx, { show: false, item: null, options, x: e.clientX, y: e.clientY })
  nextTick(() => { ctx.show = true })
}
function runBlank(key) {
  if (key === 'folder' || key === 'file') return onCreateSelect(key)
  if (key === 'upload-files') return pickFiles(false)
  if (key === 'upload-folder') return pickFiles(true)
  if (key === 'paste') return paste()
}

function toggle(it, on) {
  checked.value = on ? [...new Set([...checked.value, it.path])] : checked.value.filter(p => p !== it.path)
}

// ───── list view ─────
const columns = computed(() => {
  const cols = []
  if (selectable.value) cols.push({ type: 'selection', width: 44 })
  if (starrable.value) {
    cols.push({
      title: '', key: 'star', width: 44, align: 'center',
      render: row => h(NButton, { quaternary: true, circle: true, size: 'small', title: isFav(row) ? t('files.removeFavorite') : t('files.addFavorite'), onClick: () => toggleFav(row) }, {
        icon: () => h(NIcon, { component: isFav(row) ? Star : StarOutline, color: isFav(row) ? '#f59e0b' : undefined }),
      }),
    })
  }
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
const rowProps = row => ({
  'data-path': row.path,
  draggable: can('write'),
  onContextmenu: e => { e.preventDefault(); e.stopPropagation(); openContext(e, row) },
  onClick: () => { cursor.value = row.path; anchor = row.path },
  onDragstart: e => dragStart(e, row),
  onDragend: dragEnd,
  ...(row.type === 'dir' ? { onDragover: e => dropOver(e, row.path), onDragleave: e => dropLeave(e, row.path), onDrop: e => dropDo(e, row.path) } : {}),
})
const rowClass = row => [cursor.value === row.path ? 'row-cursor' : '', dropKey.value === row.path ? 'drop-on' : ''].filter(Boolean).join(' ')

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
// our own drags (rows) carry this type and never "Files": the desktop upload above and the move below can not be mixed up
const MIME = 'application/x-fc-items'
const isOurs = e => [...(e.dataTransfer?.types || [])].includes(MIME)
function onDragOver(e) {
  e.preventDefault()
  // over nothing that takes it (a file row, empty space): the browser shows the "no drop" cursor
  if (isOurs(e)) e.dataTransfer.dropEffect = 'none'
}
function onDragEnter(e) { if (can('upload') && hasFiles(e) && !isOurs(e)) { dragDepth++; dragging.value = true } }
function onDragLeave() { if (dragging.value && --dragDepth <= 0) { dragging.value = false; dragDepth = 0 } }
function onDrop(e) {
  dragging.value = false
  dragDepth = 0
  if (!can('upload') || !hasFiles(e) || isOurs(e)) return
  collectDropped(e.dataTransfer).then(list => list.length && uploader.value?.add(list, location.value))
}

// ───── drag & drop: move (Ctrl / Cmd = copy) a row or the selection onto a folder or a breadcrumb ─────
/** what is being dragged: { space, paths }. Kept here because a page can only read the type of a drag, not its data, before the drop */
let drag = null
/** the folder (its path) under the pointer that takes the drop */
const dropKey = ref('')
let ghost = null
/** counts the dragover events: a dragleave is final only when none came after it */
let overAt = 0
function dragStart(e, row) {
  if (!can('write')) return e.preventDefault()
  const paths = checked.value.includes(row.path) ? [...checked.value] : [row.path]
  drag = { space: props.space, paths }
  e.dataTransfer.setData(MIME, JSON.stringify(drag))
  e.dataTransfer.effectAllowed = 'copyMove'
  if (paths.length > 1) {
    // "n items" follows the pointer instead of one row's picture
    ghost = document.createElement('div')
    ghost.textContent = t('files.itemCount', { n: paths.length })
    ghost.style.cssText = 'position:fixed;top:-100px;left:-100px;padding:6px 12px;border-radius:8px;background:#2563eb;color:#fff;font:600 13px sans-serif'
    document.body.appendChild(ghost)
    e.dataTransfer.setDragImage(ghost, 10, 10)
  }
}
function dragEnd() {
  drag = null
  dropKey.value = ''
  ghost?.remove()
  ghost = null
}
/** what of the dragged items may go into `dest`: not a folder into itself or its own child, nothing into the folder it is in */
const movable = dest => (drag ? drag.paths.filter(p => p !== dest && !dest.startsWith(`${p}/`) && parentPath(p) !== dest) : [])
function dropOver(e, dest) {
  if (!isOurs(e) || !drag || drag.space !== props.space || !can('write')) return
  // a stale highlight is better than none: this is the only place that says "here is a target"
  e.preventDefault()
  e.stopPropagation()
  if (!movable(dest).length) { e.dataTransfer.dropEffect = 'none'; dropKey.value = ''; return }
  e.dataTransfer.dropEffect = e.ctrlKey || e.metaKey ? 'copy' : 'move'
  overAt++
  dropKey.value = dest
}
function dropLeave(e, dest) {
  // moving between the parts of one target (icon, text) is not leaving it (not every browser names the element entered)
  if (e.currentTarget?.contains?.(e.relatedTarget)) return
  // the next dragover of the same target (every few tens of ms while the pointer is over it) cancels this
  const seen = overAt
  setTimeout(() => { if (dropKey.value === dest && overAt === seen) dropKey.value = '' }, 120)
}
async function dropDo(e, dest) {
  if (!isOurs(e)) return
  e.preventDefault()
  e.stopPropagation()
  const copy = e.ctrlKey || e.metaKey
  const all = drag?.paths || []
  const paths = drag && drag.space === props.space && can('write') ? movable(dest) : []
  dragEnd()
  if (!paths.length) {
    if (all.length) fb.warn(t('files.dropRefused'))
    return
  }
  await transferTo(copy ? 'copy' : 'move', paths, dest)
}
/** the one place that moves or copies in this space; says what happened and reads the folder again */
async function transferTo(kind, paths, dest) {
  try {
    const r = await (kind === 'copy' ? api.copy : api.move)(props.space, paths, dest)
    if (r.failed.length) fb.warn(t('files.partial', { ok: r.done, failed: r.failed.length, reason: r.failed[0].error }))
    else fb.ok(t(kind === 'copy' ? 'files.copiedTo' : 'files.movedTo', { n: r.done, folder: dest === '/' ? t('common.home') : baseName(dest) }))
    checked.value = []
    await load(true)
    return r
  } catch (e) { fb.fail(e) }
}

// ───── the in-page clipboard: Ctrl+C / Ctrl+X, then Ctrl+V in any folder of this space ─────
async function paste() {
  if (!clip.value?.paths.length || !can('write')) return
  const { mode, paths } = clip.value
  const r = await transferTo(mode === 'cut' ? 'move' : 'copy', paths, location.value)
  // a cut is spent once it has gone; what stayed (it failed) can be tried again
  if (r && mode === 'cut') clip.value = r.failed.length ? { mode, paths: r.failed.map(f => f.path) } : null
}

// ───── keyboard ─────
const shortcutList = computed(() => {
  const w = can('write')
  return [
    { keys: 'Enter', text: 'open' }, { keys: 'Backspace', text: 'up' }, { keys: '↑/↓', text: 'move' }, { keys: 'Shift+↑/↓', text: 'extend' },
    ...(selectable.value ? [{ keys: 'Ctrl/⌘+A', text: 'all' }] : []),
    { keys: 'Esc', text: 'clear' },
    ...(w ? [{ keys: 'F2', text: 'rename' }, { keys: 'Del', text: 'delete' }, { keys: 'Ctrl/⌘+C', text: 'copy' }, { keys: 'Ctrl/⌘+X', text: 'cut' }, { keys: 'Ctrl/⌘+V', text: 'paste' }] : []),
    { keys: '/', text: 'search' }, { keys: '?', text: 'help' },
  ]
})

/** the rows the arrow keys walk over, in the order they are shown */
const rowsInOrder = () => (app.view === 'list' ? sorted.value : gridItems.value)
/** what a key acts on: the selection, else the row the arrow keys are on */
function targets() {
  if (selected.value.length) return selected.value
  const it = visible.value.find(i => i.path === cursor.value)
  return it ? [it] : []
}
/** a modal, a dialog, a menu or a drop-down list is open: the keys belong to it */
function overlayOpen() {
  if (preview.show || office.show || versions.show || share.show || grant.show || picker.show || prompt.show || searchOpen.value || keysOpen.value || ctx.show) return true
  // (the empty `.n-modal-container` stays behind after a close, so look for what is inside it)
  return !!document.querySelector('.n-modal-mask, .n-modal, .n-dialog, .n-dropdown-menu, .n-base-select-menu, .n-popover, .n-drawer-mask, .n-drawer')
}
function typing(el) {
  if (!el || el === document.body) return false
  return !!el.closest?.('input, textarea, select, [contenteditable=""], [contenteditable="true"], .cm-editor')
}
function scrollToRow(path) {
  nextTick(() => {
    const el = [...(root.value?.querySelectorAll('[data-path]') || [])].find(n => n.getAttribute('data-path') === path)
    el?.scrollIntoView({ block: 'nearest' })
  })
}
function moveCursor(step, extend) {
  const list = rowsInOrder()
  if (!list.length) return
  const at = list.findIndex(i => i.path === cursor.value)
  const next = at < 0 ? (step > 0 ? 0 : list.length - 1) : Math.min(list.length - 1, Math.max(0, at + step))
  const path = list[next].path
  if (extend && selectable.value) {
    if (!anchor || !list.some(i => i.path === anchor)) anchor = cursor.value || path
    const a = list.findIndex(i => i.path === anchor)
    checked.value = list.slice(Math.min(a, next), Math.max(a, next) + 1).map(i => i.path)
  } else anchor = path
  cursor.value = path
  // the list is paged: show the page the row is on
  if (app.view === 'list') pagination.page = Math.floor(next / pagination.pageSize) + 1
  scrollToRow(path)
}
function onKey(e) {
  if (e.defaultPrevented || e.isComposing || e.altKey) return
  // a manual dropdown does not close itself on Escape
  if (ctx.show && e.key === 'Escape') { ctx.show = false; e.preventDefault(); return }
  if (typing(e.target) || overlayOpen()) return
  // only while the focus is in the page's content (not the side menu or the top bar)
  if (e.target !== document.body && !root.value?.contains(e.target)) return
  const mod = e.ctrlKey || e.metaKey
  const key = e.key
  const stop = () => e.preventDefault()
  const w = can('write')
  if (!mod && key === 'Delete') {
    const list = targets()
    if (w && list.length) { stop(); remove(list) }
  } else if (!mod && key === 'F2') {
    const list = targets()
    if (w && list.length === 1) { stop(); rename(list[0]) }
  } else if (mod && key.toLowerCase() === 'a') {
    if (selectable.value && !window.getSelection()?.toString()) { stop(); checked.value = visible.value.map(i => i.path) }
  } else if (!mod && key === 'Escape') {
    if (checked.value.length) checked.value = []
    else if (clip.value) clip.value = null
    else cursor.value = ''
  } else if (!mod && key === 'Enter') {
    // a focused button does its own click: opening twice would be the result
    if (e.target?.closest?.('button, a, [role="button"], [role="checkbox"]')) return
    const list = targets()
    if (list.length === 1) { stop(); open(list[0]) }
  } else if (!mod && key === 'Backspace') {
    if (location.value !== '/') { stop(); go(parentPath(location.value)) }
  } else if (!mod && (key === 'ArrowDown' || key === 'ArrowUp')) {
    if (rowsInOrder().length) { stop(); moveCursor(key === 'ArrowDown' ? 1 : -1, e.shiftKey) }
  } else if (mod && (key.toLowerCase() === 'c' || key.toLowerCase() === 'x')) {
    const list = targets()
    // a text selection on the page keeps the browser's own copy
    if (w && list.length && !window.getSelection()?.toString()) {
      stop()
      clip.value = { mode: key.toLowerCase() === 'x' ? 'cut' : 'copy', paths: list.map(i => i.path) }
    }
  } else if (mod && key.toLowerCase() === 'v') {
    if (w && clip.value?.paths.length) { stop(); paste() }
  } else if (!mod && key === '/') {
    stop()
    searchOpen.value = true
  } else if (!mod && key === '?') {
    stop()
    keysOpen.value = true
  }
}
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => { window.removeEventListener('keydown', onKey); ghost?.remove() })

function onSearchSelect(it) {
  if (it.type === 'dir') return go(it.path)
  const dir = parentPath(it.path)
  const finish = () => { preview.item = it; preview.show = kindOf(it.name) !== 'other' && can('download') }
  if (dir === location.value) return finish()
  go(dir).then(() => setTimeout(finish, 250))
}
</script>

<style scoped>
/* tall enough to leave empty space under a short list: that is where a right-click opens the folder's own menu */
.browser { position: relative; min-height: calc(100vh - 240px); }
.toolbar { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; }
.left, .right { display: flex; align-items: center; gap: 8px; }
.usage { margin: -4px 0 12px; max-width: 360px; display: flex; flex-direction: column; gap: 4px; }
.usage .small { font-size: 12.5px; }
.crumbs { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; min-height: 28px; flex-wrap: wrap; }
.crumbs .n-breadcrumb { min-width: 0; }
/* long Thai folder names have no spaces: the trail wraps inside the screen instead of pushing the page sideways */
.crumbs :deep(.n-breadcrumb ul) { display: flex; flex-wrap: wrap; row-gap: 2px; }
.crumbs :deep(.n-breadcrumb-item) { min-width: 0; white-space: normal; }
.crumbs :deep(.n-breadcrumb-item__link) { overflow-wrap: anywhere; }
.crumb { display: inline-block; cursor: pointer; overflow-wrap: anywhere; padding: 1px 5px; margin: -1px -5px; border-radius: 6px; }
/* where a dragged row would land */
.crumb.drop-on, .card.drop-on { outline: 2px solid var(--primary); background: var(--primary-soft); }
:deep(.n-data-table-tr.drop-on > td) { background: var(--primary-soft) !important; box-shadow: inset 0 2px 0 var(--primary), inset 0 -2px 0 var(--primary); }
/* the row the arrow keys are on */
:deep(.n-data-table-tr.row-cursor > td) { background: color-mix(in srgb, var(--primary) 8%, transparent) !important; }
:deep(.n-data-table-tr.row-cursor > td:first-child) { box-shadow: inset 3px 0 0 var(--primary); }
.card.cursor { border-color: var(--primary); box-shadow: 0 0 0 2px var(--primary-soft); }
.clip { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 6px 12px; margin-bottom: 12px; border-radius: var(--radius); background: var(--surface-2); border: 1px dashed var(--border); font-size: 13.5px; }
.clip-text { font-weight: 500; margin-right: auto; }
.keys-hint { font-size: 13px; margin: 0 0 12px; }
.keys { display: grid; grid-template-columns: minmax(110px, auto) 1fr; gap: 8px 16px; margin: 0 0 12px; align-items: center; }
.keys dt { white-space: nowrap; }
.keys dd { margin: 0; font-size: 14px; overflow-wrap: anywhere; }
.keys kbd { display: inline-block; min-width: 22px; padding: 2px 7px; text-align: center; border: 1px solid var(--border); border-bottom-width: 2px; border-radius: 6px; background: var(--surface-2); font: 600 12.5px ui-monospace, Menlo, Consolas, monospace; }
.keys .plus { margin: 0 3px; color: var(--muted); }
/* a phone has no keyboard to look the keys up for */
@media (max-width: 640px) { .keys-btn { display: none; } }
.crumb .n-icon { vertical-align: -2px; margin-right: 4px; }
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
.card-star { position: absolute; top: 12px; right: 44px; background: var(--surface); }
.card-menu { position: absolute; top: 12px; right: 12px; background: var(--surface); }
.more { grid-column: 1 / -1; text-align: center; }
.drop { position: fixed; inset: 0; z-index: 100; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; background: color-mix(in srgb, var(--primary) 14%, transparent); border: 3px dashed var(--primary); color: var(--primary); font-size: 18px; font-weight: 600; pointer-events: none; }
.foot { display: flex; justify-content: flex-end; gap: 8px; }
.fade-enter-active, .fade-leave-active { transition: opacity 0.15s; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
:deep(.name-cell) { all: unset; display: flex; align-items: center; gap: 10px; cursor: pointer; max-width: 100%; }
:deep(.name-cell:hover .name-text) { color: var(--primary); text-decoration: underline; }
:deep(.name-text) { min-width: 0; }
/* phones cannot hover for the title: long names wrap onto more lines instead of ending in "…" */
@media (max-width: 640px) {
  :deep(.name-text), .card-name { white-space: normal; overflow-wrap: anywhere; }
}
</style>
