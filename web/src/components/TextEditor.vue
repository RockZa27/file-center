<template>
  <div class="text-editor">
    <div v-if="loading" class="state"><n-spin size="small" /><span class="muted">{{ t('preview.loading') }}</span></div>
    <n-alert v-else-if="loadError" type="warning">{{ loadError }}</n-alert>

    <template v-else-if="kind === 'csv'">
      <csv-table v-if="canEdit" :rows="table.rows" :delimiter="table.delimiter" @change="edits++" />
      <sheet-grid v-else :rows="table.rows" />
    </template>

    <div v-else-if="kind === 'markdown'" class="md" :class="{ split: canEdit }">
      <div v-if="canEdit" class="pane">
        <div class="pane-title muted">{{ t('editor.source') }}</div>
        <div ref="codeHost" class="code-host" />
      </div>
      <div class="pane">
        <div v-if="canEdit" class="pane-title muted">{{ t('editor.preview') }}</div>
        <div ref="mdOut" class="md-body" />
      </div>
    </div>

    <div v-else ref="codeHost" class="code-host tall" />

    <div v-if="canEdit && !loading && !loadError" class="hint muted">{{ t('editor.saveHint', { key: isMac ? '⌘S' : 'Ctrl+S' }) }}</div>

    <n-modal v-model:show="conflict" preset="card" :title="t('editor.conflictTitle')" :bordered="false" style="width: min(520px, 94vw)" :mask-closable="false">
      <p class="conflict-text">{{ t('editor.conflictText') }}</p>
      <template #footer>
        <div class="conflict-actions">
          <n-button @click="conflict = false">{{ t('editor.keepEditing') }}</n-button>
          <n-button secondary @click="reloadTheirs">{{ t('editor.reloadTheirs') }}</n-button>
          <n-button type="error" @click="overwrite">{{ t('editor.overwrite') }}</n-button>
        </div>
      </template>
    </n-modal>
  </div>
</template>

<script setup>
import { computed, markRaw, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { NAlert, NButton, NModal, NSpin } from 'naive-ui'
import { api } from '../api'
import { useFeedback } from '../composables'
import { extOf, formatBytes, joinPath, kindOf, parentPath } from '../utils'
import { parseCsv, squareUp, toCsv } from '../viewers/csv'
import CsvTable from './CsvTable.vue'
import SheetGrid from './SheetGrid.vue'

/**
 * Text files in the preview: code and plain text in CodeMirror (line numbers, colours), Markdown with a live
 * preview beside it (stacked on phones), CSV as a table. Saving sends the version the editor started from;
 * when someone else saved meanwhile the user chooses between their version and overwriting it.
 */
const props = defineProps({ space: String, item: Object, canEdit: Boolean, siblings: { type: Array, default: () => [] } })
const emit = defineEmits(['saved'])
const { t, locale } = useI18n()
const fb = useFeedback()
const TEXT_OPEN_MAX = 2 * 1024 * 1024
const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)

const kind = computed(() => kindOf(props.item.name))
const ext = computed(() => extOf(props.item.name))
const loading = ref(false)
const loadError = ref('')
const saving = ref(false)
const conflict = ref(false)
const text = ref('')
const original = ref('')
const mtime = ref(undefined)
// CSV: the rows (changed in place by the table), how the file writes them, and how many edits since loading
const table = shallowRef({ rows: [], delimiter: ',', eol: '\n', bom: false, trailingNewline: true })
const edits = ref(0)
const codeHost = ref(null)
const mdOut = ref(null)
let editor = null
let generation = 0

const dirty = computed(() => props.canEdit && !loading.value && !loadError.value && (kind.value === 'csv' ? edits.value > 0 : text.value !== original.value))

function content() {
  if (kind.value !== 'csv') return text.value
  const { rows, ...format } = table.value
  return toCsv(rows, format)
}

async function load() {
  const run = ++generation
  loadError.value = ''
  destroyEditor()
  // the server opens text files up to 2 MB (MAX_TEXT): bigger ones are not asked for at all
  if (props.item.size > TEXT_OPEN_MAX) {
    loadError.value = t('editor.tooBig', { size: formatBytes(props.item.size), max: formatBytes(TEXT_OPEN_MAX, 0) })
    return
  }
  loading.value = true
  try {
    const res = await api.getContent(props.space, props.item.path)
    if (run !== generation) return
    text.value = original.value = res.content
    mtime.value = res.mtime
    if (kind.value === 'csv') {
      const parsed = parseCsv(res.content, ext.value === 'tsv' ? '\t' : undefined)
      table.value = markRaw({ ...parsed, rows: squareUp(parsed.rows) })
      edits.value = 0
    }
  } catch (e) {
    if (run !== generation) return
    loadError.value = e.message
  } finally {
    if (run === generation) loading.value = false
  }
  if (run !== generation || loadError.value) return
  await nextTick()
  await mountEditor(run)
}

async function mountEditor(run) {
  if (kind.value === 'markdown') renderPreview()
  if (kind.value === 'csv' || (kind.value === 'markdown' && !props.canEdit)) return
  const { createEditor } = await import('../viewers/code.js')
  if (run !== generation || !codeHost.value) return
  editor = await createEditor({
    parent: codeHost.value, text: text.value, ext: ext.value, readOnly: !props.canEdit,
    onChange: v => { text.value = v },
    onSave: () => save(),
  })
  if (run !== generation) destroyEditor()
}

function destroyEditor() {
  editor?.destroy()
  editor = null
}

// ───── Markdown preview ─────
let markdown = null
let previewTimer = null
const siblingPaths = computed(() => new Set(props.siblings.filter(s => s.type === 'file').map(s => s.path)))
/** a picture or link next to the file: pictures only when they exist in this folder, links to their download */
function resolve(href, type) {
  let path
  try { path = decodeURIComponent(href.split(/[?#]/)[0]) } catch { return null }
  if (!path) return null
  let dir = parentPath(props.item.path)
  if (path.startsWith('/')) { dir = '/'; path = path.slice(1) }
  for (const part of path.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') dir = parentPath(dir)
    else dir = joinPath(dir, part)
  }
  if (type === 'image') return siblingPaths.value.has(dir) ? api.downloadUrl(props.space, dir, true) : null
  return api.downloadUrl(props.space, dir)
}
async function renderPreview() {
  if (!markdown) markdown = await import('../viewers/markdown.js')
  if (!mdOut.value) return
  mdOut.value.replaceChildren(markdown.renderMarkdown(text.value, resolve))
}
watch(text, () => {
  if (kind.value !== 'markdown') return
  clearTimeout(previewTimer)
  previewTimer = setTimeout(renderPreview, 150)
})

// ───── saving ─────
async function save(force = false) {
  if (!dirty.value || saving.value) return
  saving.value = true
  const body = content()
  const editsSent = edits.value
  try {
    const res = await api.putContent(props.space, props.item.path, body, force ? undefined : mtime.value)
    mtime.value = res.mtime
    // what was sent; typing that went on meanwhile stays unsaved
    original.value = body
    edits.value -= editsSent
    fb.ok(t('common.saved'))
    emit('saved')
  } catch (e) {
    if (e.status === 409 && e.code === 'files.changed-elsewhere') conflict.value = true
    else fb.fail(e)
  } finally {
    saving.value = false
  }
}

async function reloadTheirs() {
  conflict.value = false
  await load()
  if (!loadError.value) fb.ok(t('editor.reloaded'))
}

async function overwrite() {
  const sure = await fb.confirm({ title: t('editor.overwriteTitle'), content: t('editor.overwriteText'), positive: t('editor.overwrite'), danger: true })
  if (!sure) return
  conflict.value = false
  await save(true)
}

/** Ctrl/Cmd+S anywhere in the preview saves (CodeMirror handles it itself while it has the focus) */
function onKeys(e) {
  if (e.defaultPrevented || !(e.ctrlKey || e.metaKey) || e.altKey || e.key.toLowerCase() !== 's') return
  e.preventDefault()
  if (props.canEdit) save()
}
onMounted(() => window.addEventListener('keydown', onKeys))

watch(() => props.item?.path, load, { immediate: true })
// the server's text of a failed load (and the page's own) follows the language switch
watch(locale, () => { if (loadError.value) load() })
onBeforeUnmount(() => {
  generation++
  clearTimeout(previewTimer)
  window.removeEventListener('keydown', onKeys)
  destroyEditor()
})

defineExpose({ dirty, saving, save })
</script>

<style scoped>
.text-editor { width: 100%; min-width: 0; }
.state { display: flex; align-items: center; justify-content: center; gap: 10px; padding: 48px 0; }
.code-host { height: 52vh; min-height: 220px; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
.code-host.tall { height: 60vh; }
.md { display: grid; grid-template-columns: minmax(0, 1fr); gap: 12px; }
.md.split { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
.pane { min-width: 0; }
.pane-title { font-size: 12px; margin-bottom: 4px; }
.md-body { height: 52vh; min-height: 220px; overflow: auto; padding: 12px 16px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); line-height: 1.65; overflow-wrap: anywhere; }
.md:not(.split) .md-body { height: auto; max-height: 64vh; }
.hint { font-size: 12px; margin-top: 6px; text-align: right; }
.conflict-text { margin: 0; line-height: 1.6; }
.conflict-actions { display: flex; justify-content: flex-end; gap: 8px; flex-wrap: wrap; }
@media (max-width: 760px) {
  .md.split { grid-template-columns: minmax(0, 1fr); }
  .md.split .code-host, .md.split .md-body { height: 36vh; }
}
.md-body :deep(h1), .md-body :deep(h2), .md-body :deep(h3) { margin: 0.8em 0 0.4em; line-height: 1.3; }
.md-body :deep(h1) { font-size: 1.6em; }
.md-body :deep(h2) { font-size: 1.3em; border-bottom: 1px solid var(--border); padding-bottom: 0.2em; }
.md-body :deep(:first-child) { margin-top: 0; }
.md-body :deep(p), .md-body :deep(ul), .md-body :deep(ol), .md-body :deep(blockquote), .md-body :deep(table), .md-body :deep(pre) { margin: 0 0 0.8em; }
.md-body :deep(code) { font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace; font-size: 0.9em; background: var(--surface-2); padding: 0.1em 0.35em; border-radius: 4px; }
.md-body :deep(pre) { background: var(--surface-2); padding: 10px 12px; border-radius: 8px; overflow-x: auto; }
.md-body :deep(pre code) { padding: 0; background: none; }
.md-body :deep(blockquote) { padding: 0 0 0 12px; border-left: 3px solid var(--border); color: var(--muted); }
.md-body :deep(table) { border-collapse: collapse; display: block; overflow-x: auto; max-width: 100%; }
.md-body :deep(th), .md-body :deep(td) { border: 1px solid var(--border); padding: 4px 10px; }
.md-body :deep(th) { background: var(--surface-2); }
.md-body :deep(img) { max-width: 100%; }
.md-body :deep(a) { color: var(--primary); }
.md-body :deep(hr) { border: 0; border-top: 1px solid var(--border); }
</style>

<style>
/* syntax colours of the code editor (CodeMirror's tok-* classes), readable on light and dark backgrounds */
.cm-editor .tok-keyword, .cm-editor .tok-operatorKeyword, .cm-editor .tok-modifier, .cm-editor .tok-controlKeyword { color: #7c3aed; }
.cm-editor .tok-string, .cm-editor .tok-string2, .cm-editor .tok-inserted { color: #15803d; }
.cm-editor .tok-comment, .cm-editor .tok-meta { color: #6b7280; font-style: italic; }
.cm-editor .tok-number, .cm-editor .tok-bool, .cm-editor .tok-atom, .cm-editor .tok-literal { color: #c2410c; }
.cm-editor .tok-typeName, .cm-editor .tok-className, .cm-editor .tok-namespace, .cm-editor .tok-tagName { color: #0369a1; }
.cm-editor .tok-propertyName, .cm-editor .tok-attributeName { color: #1d4ed8; }
.cm-editor .tok-definition { color: #b45309; }
.cm-editor .tok-heading { color: #1d4ed8; font-weight: 600; }
.cm-editor .tok-link, .cm-editor .tok-url { color: #2563eb; text-decoration: underline; }
.cm-editor .tok-emphasis { font-style: italic; }
.cm-editor .tok-strong { font-weight: 600; }
.cm-editor .tok-deleted, .cm-editor .tok-invalid { color: #dc2626; }
:root[data-theme='dark'] .cm-editor .tok-keyword, :root[data-theme='dark'] .cm-editor .tok-operatorKeyword,
:root[data-theme='dark'] .cm-editor .tok-modifier, :root[data-theme='dark'] .cm-editor .tok-controlKeyword { color: #c4b5fd; }
:root[data-theme='dark'] .cm-editor .tok-string, :root[data-theme='dark'] .cm-editor .tok-string2, :root[data-theme='dark'] .cm-editor .tok-inserted { color: #86efac; }
:root[data-theme='dark'] .cm-editor .tok-comment, :root[data-theme='dark'] .cm-editor .tok-meta { color: #9ca3af; }
:root[data-theme='dark'] .cm-editor .tok-number, :root[data-theme='dark'] .cm-editor .tok-bool,
:root[data-theme='dark'] .cm-editor .tok-atom, :root[data-theme='dark'] .cm-editor .tok-literal { color: #fdba74; }
:root[data-theme='dark'] .cm-editor .tok-typeName, :root[data-theme='dark'] .cm-editor .tok-className,
:root[data-theme='dark'] .cm-editor .tok-namespace, :root[data-theme='dark'] .cm-editor .tok-tagName { color: #7dd3fc; }
:root[data-theme='dark'] .cm-editor .tok-propertyName, :root[data-theme='dark'] .cm-editor .tok-attributeName,
:root[data-theme='dark'] .cm-editor .tok-heading, :root[data-theme='dark'] .cm-editor .tok-link { color: #93c5fd; }
:root[data-theme='dark'] .cm-editor .tok-definition { color: #fcd34d; }
:root[data-theme='dark'] .cm-editor .tok-deleted, :root[data-theme='dark'] .cm-editor .tok-invalid { color: #fca5a5; }
</style>
