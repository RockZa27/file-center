<template>
  <teleport to="body">
    <div v-if="show && item" class="office" role="dialog" :aria-label="item.name">
      <header class="office-bar">
        <n-icon :component="mode === 'edit' ? CreateOutline : EyeOutline" size="18" class="muted" />
        <span class="name" :title="item.name">{{ item.name }}</span>
        <n-tag v-if="mode === 'view'" size="small" :bordered="false">{{ t('office.viewOnly') }}</n-tag>
        <n-button class="close" secondary size="small" @click="close">
          <template #icon><n-icon :component="CloseOutline" /></template>{{ t('common.close') }}
        </n-button>
      </header>
      <div class="office-body">
        <div v-if="loading" class="state"><n-spin size="small" /><span class="muted">{{ t('office.loading') }}</span></div>
        <div v-if="error" class="state">
          <n-result status="warning" :title="error.text ?? t(error.key)">
            <template #footer>
              <div class="row"><n-button @click="start">{{ t('common.retry') }}</n-button><n-button type="primary" @click="close">{{ t('common.close') }}</n-button></div>
            </template>
          </n-result>
        </div>
        <!-- DocsAPI puts its frame in place of an element made here for each start (Vue does not track it) -->
        <div v-show="!loading && !error" ref="box" class="frame-box" />
      </div>
    </div>
  </teleport>
</template>

<script>
// the editor script of each document server, loaded once per page
const scripts = new Map()
</script>

<script setup>
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { NButton, NIcon, NResult, NSpin, NTag } from 'naive-ui'
import { CloseOutline, CreateOutline, EyeOutline } from '@vicons/ionicons5'
import { api, ApiError } from '../api'
import { useNarrow } from '../composables'

/**
 * ONLYOFFICE Docs over the whole screen. The server signs the editor config (POST /api/office/config); the editor
 * script comes from the document server (its origin is allowed by the page's security policy only when set up).
 * The document server saves through its callback a few seconds after the editor closes: `closed` says whether the
 * user changed anything so the folder can wait for the new version.
 */
const props = defineProps({ show: Boolean, space: String, item: Object, mode: { type: String, default: 'view' } })
const emit = defineEmits(['update:show', 'closed'])
const { t, locale } = useI18n()
const narrow = useNarrow()

const frameId = `office-frame-${Math.random().toString(36).slice(2)}`
const loading = ref(false)
/** { key } for the page's texts, { text, server: true } for the server's */
const error = ref(null)
const box = ref(null)
let editor = null
let edited = false
let generation = 0

function loadScript(src) {
  if (!scripts.has(src)) {
    scripts.set(src, new Promise((resolve, reject) => {
      const s = document.createElement('script')
      s.src = src
      s.async = true
      s.onload = () => (window.DocsAPI?.DocEditor ? resolve() : reject(new Error('no DocsAPI')))
      s.onerror = () => { s.remove(); reject(new Error('script')) }
      document.head.appendChild(s)
    }).catch(e => { scripts.delete(src); throw e }))
  }
  return scripts.get(src)
}

function destroy() {
  try { editor?.destroyEditor?.() } catch { /* the frame is gone already */ }
  editor = null
  box.value?.replaceChildren()
}

async function start() {
  const run = ++generation
  destroy()
  error.value = null
  loading.value = true
  edited = false
  try {
    const { apiUrl, config } = await api.officeConfig(props.space, props.item.path, props.mode)
    if (run !== generation) return
    await loadScript(apiUrl)
    if (run !== generation) return
    loading.value = false
    await nextTick()
    if (run !== generation || !box.value) return
    const place = document.createElement('div')
    place.id = frameId
    box.value.replaceChildren(place)
    editor = new window.DocsAPI.DocEditor(frameId, {
      ...config,
      width: '100%',
      height: '100%',
      type: narrow.value ? 'mobile' : 'desktop',
      events: {
        onDocumentStateChange: e => { if (e?.data) edited = true },
        onRequestClose: close,
        onError: e => { if (run === generation) error.value = { text: t('office.editorError', { text: e?.data?.errorDescription ?? e?.data?.errorCode ?? '' }) } },
      },
    })
  } catch (e) {
    if (run !== generation) return
    error.value = e instanceof ApiError ? { text: e.message, server: true } : { key: 'office.loadFailed' }
  } finally {
    if (run === generation) loading.value = false
  }
}

function close() {
  generation++
  destroy()
  emit('update:show', false)
  emit('closed', { item: props.item, mode: props.mode, edited: props.mode === 'edit' && edited })
}

watch(() => [props.show, props.item?.path, props.mode], () => { if (props.show && props.item) start() }, { immediate: true })
watch(locale, () => { if (props.show && error.value?.server) start() })
onBeforeUnmount(() => { generation++; destroy() })
</script>

<style scoped>
.office { position: fixed; inset: 0; z-index: 3000; display: flex; flex-direction: column; background: var(--surface); }
.office-bar { display: flex; align-items: center; gap: 10px; min-height: 48px; padding: 6px 12px; border-bottom: 1px solid var(--border); }
.name { flex: 1; min-width: 0; font-weight: 600; overflow-wrap: anywhere; line-height: 1.35; }
.close { flex-shrink: 0; }
.office-body { position: relative; flex: 1; min-height: 0; }
.frame-box, .frame-box > :deep(*) { width: 100%; height: 100%; }
.state { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; gap: 10px; padding: 16px; }
</style>
