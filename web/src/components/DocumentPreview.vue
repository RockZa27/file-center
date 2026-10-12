<template>
  <div class="doc-preview">
    <div v-if="tooBig" class="state">
      <n-result status="info" :title="t('preview.tooBigTitle')" :description="t('preview.tooBig', { size: formatBytes(item.size), max: formatBytes(DOCUMENT_PREVIEW_MAX, 0) })">
        <template v-if="canDownload" #footer>
          <n-button type="primary" tag="a" :href="api.downloadUrl(space, item.path)">
            <template #icon><n-icon :component="DownloadOutline" /></template>{{ t('common.download') }}
          </n-button>
        </template>
      </n-result>
    </div>
    <n-alert v-else-if="error" type="warning" class="state">{{ error.text ?? t(error.key) }}</n-alert>
    <div v-if="loading" class="state loading"><n-spin size="small" /><span class="muted">{{ t('preview.loading') }}</span></div>

    <div v-show="kind === 'docx' && ready" ref="docxHost" class="docx-host" />

    <div v-show="kind === 'slides' && ready" ref="slidesScroll" class="slides-scroll">
      <div ref="slidesHost" class="slides-host" />
    </div>

    <template v-if="kind === 'sheet' && ready && sheets.length">
      <n-tabs v-if="sheets.length > 1" v-model:value="activeSheet" type="line" size="small" class="tabs">
        <n-tab v-for="(s, i) in sheets" :key="i" :name="i">{{ s.name || `#${i + 1}` }}{{ s.hidden ? ` ${t('preview.hiddenSheet')}` : '' }}</n-tab>
      </n-tabs>
      <sheet-grid :key="activeSheet" :rows="sheets[activeSheet].rows" :total-rows="sheets[activeSheet].totalRows" :total-cols="sheets[activeSheet].totalCols" />
    </template>
  </div>
</template>

<script setup>
import { computed, markRaw, nextTick, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { NAlert, NButton, NIcon, NResult, NSpin, NTab, NTabs } from 'naive-ui'
import { DownloadOutline } from '@vicons/ionicons5'
import { api, ApiError } from '../api'
import { useNarrow } from '../composables'
import { DOCUMENT_PREVIEW_MAX, extOf, formatBytes, kindOf } from '../utils'
import SheetGrid from './SheetGrid.vue'

/** Word, Excel / OpenDocument spreadsheets and PowerPoint drawn in the page; each viewer loads on first use */
const props = defineProps({ space: String, item: Object, canDownload: Boolean })
const { t, locale } = useI18n()
const narrow = useNarrow('(max-width: 760px)')

const kind = computed(() => kindOf(props.item.name))
const tooBig = computed(() => props.item.size > DOCUMENT_PREVIEW_MAX)
const loading = ref(false)
const ready = ref(false)
/** { key } for the page's own texts, { text, server: true } for the server's (asked again on a language switch) */
const error = ref(null)
const sheets = shallowRef([])
const activeSheet = ref(0)
const docxHost = ref(null)
const slidesHost = ref(null)
const slidesScroll = ref(null)
let cleanup = null
let generation = 0

function release() {
  generation++
  try { cleanup?.() } catch { /* already gone */ }
  cleanup = null
  sheets.value = []
  ready.value = false
}

const SHEET_ERRORS = { 'too-big': 'preview.unpackTooBig', unreadable: 'preview.unreadable', unsupported: 'preview.unreadable', encrypted: 'preview.encrypted' }

async function show() {
  release()
  error.value = null
  if (tooBig.value) return
  const run = generation
  loading.value = true
  try {
    const bytes = await api.fileBytes(props.space, props.item.path)
    if (run !== generation) return
    if (kind.value === 'docx') {
      const { renderDocx } = await import('../viewers/docx.js')
      if (run !== generation) return
      const free = await renderDocx(bytes, docxHost.value, { narrow: narrow.value })
      if (run !== generation) return free()
      cleanup = free
    } else if (kind.value === 'sheet') {
      const { readWorkbook } = await import('../viewers/sheet.js')
      if (run !== generation) return
      const list = readWorkbook(bytes, extOf(props.item.name))
      sheets.value = markRaw(list)
      activeSheet.value = Math.max(0, list.findIndex(s => !s.hidden))
      if (!list.length) error.value = { key: 'preview.emptySheet' }
    } else if (kind.value === 'slides') {
      const { renderSlides } = await import('../viewers/slides.js')
      if (run !== generation) return
      // the viewer measures the width it fits slides into: it has to be on screen first
      ready.value = true
      await nextTick()
      const viewer = await renderSlides(bytes, slidesHost.value, slidesScroll.value)
      if (run !== generation) return viewer.destroy()
      cleanup = viewer.destroy
    }
    ready.value = true
  } catch (e) {
    if (run !== generation) return
    ready.value = false
    if (e instanceof ApiError) error.value = { text: e.message, server: true }
    else error.value = { key: SHEET_ERRORS[e?.code] ?? 'preview.renderFailed' }
  } finally {
    if (run === generation) loading.value = false
  }
}

watch(() => props.item?.path, show, { immediate: true, flush: 'post' })
// the server wrote its error in the language the page had: ask again so it follows the switch
watch(locale, () => { if (error.value?.server) show() })
onBeforeUnmount(release)
</script>

<style scoped>
.doc-preview { width: 100%; min-width: 0; }
.state { margin-bottom: 12px; }
.loading { display: flex; align-items: center; justify-content: center; gap: 10px; padding: 48px 0; }
.docx-host { max-height: 70vh; overflow: auto; border-radius: 8px; --doc-backdrop: var(--surface-2); border: 1px solid var(--border); }
.slides-scroll { max-height: 70vh; overflow: auto; border-radius: 8px; background: var(--surface-2); border: 1px solid var(--border); padding: 12px; }
.slides-host { width: 100%; margin: 0 auto; }
.tabs { margin-bottom: 8px; }
</style>
