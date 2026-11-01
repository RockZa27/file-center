<template>
  <n-modal :show="show" preset="card" :title="item?.name" :bordered="false" style="width: min(980px, 96vw)" @update:show="v => emit('update:show', v)">
    <div v-if="item" class="stage" :class="{ fill: kind === 'pdf' || kind === 'text' }" @contextmenu.prevent>
      <img v-if="kind === 'image' && !broken" @error="broken = true" :src="api.shareThumbUrl(token, item.path, 1024, item.mtime)" :alt="item.name" class="media" draggable="false">
      <video v-else-if="kind === 'video'" :src="viewUrl" controls controlslist="nodownload noplaybackrate" disablepictureinpicture class="media" />
      <audio v-else-if="kind === 'audio'" :src="viewUrl" controls controlslist="nodownload" class="audio" />
      <iframe v-else-if="kind === 'pdf'" :src="pdfUrl" class="pdf" :title="item.name" />
      <pre v-else-if="kind === 'text'" class="text">{{ text }}</pre>
      <div v-else-if="kind === 'image'" class="muted none">{{ t('shareView.noPreview') }}</div>
      <div v-else class="muted none">{{ t('shareView.noPreview') }}</div>
      <!-- the text layer: drawn over the preview, never in the way of a click or a scroll (see docs/security.md for its limits) -->
      <div v-if="watermark && kind" class="mark" :style="{ backgroundImage: markImage }" aria-hidden="true" />
    </div>
    <n-alert type="info" :show-icon="false" class="note">{{ t('shareView.viewOnlyNote') }}</n-alert>
  </n-modal>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { NAlert, NModal } from 'naive-ui'
import { api } from '../api'
import { extOf } from '../utils'

// the picture could not be made (no image tool on the server): say so instead of a broken image
const broken = ref(false)
const props = defineProps({
  show: Boolean,
  token: { type: String, required: true },
  /** { name, path, mtime } */
  item: { type: Object, default: null },
  /** the text to draw over the preview, or null */
  watermark: { type: String, default: null },
})
const emit = defineEmits(['update:show'])
const { t } = useI18n()

const IMAGE = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'avif', 'tif', 'tiff', 'heic', 'heif']
const VIDEO = ['mp4', 'webm']
const AUDIO = ['mp3', 'wav', 'ogg', 'm4a']
const TEXT = ['txt', 'md', 'csv', 'json', 'log']

const kind = computed(() => {
  const e = extOf(props.item?.name || '')
  if (IMAGE.includes(e)) return 'image'
  if (VIDEO.includes(e)) return 'video'
  if (AUDIO.includes(e)) return 'audio'
  if (e === 'pdf') return 'pdf'
  if (TEXT.includes(e)) return 'text'
  return ''
})
const viewUrl = computed(() => (props.item ? api.shareViewUrl(props.token, props.item.path) : ''))
// the browser's PDF viewer is asked to leave out its toolbar (and with it its save button); a hint, not a lock
const pdfUrl = computed(() => `${viewUrl.value}#toolbar=0&navpanes=0`)

const text = ref('')
watch(() => [props.show, props.item?.path], async () => {
  text.value = ''
  broken.value = false
  if (!props.show || kind.value !== 'text') return
  try {
    const res = await fetch(viewUrl.value, { credentials: 'same-origin' })
    text.value = res.ok ? await res.text() : ''
  } catch { text.value = '' }
}, { immediate: true })

const esc = s => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
// the text, repeated and tilted, as an SVG tile: dark text with a light edge so it reads on a light and on a dark picture
const markImage = computed(() => {
  const s = esc((props.watermark || '').slice(0, 120))
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="460" height="220"><g transform="rotate(-24 230 110)" font-family="sans-serif" font-size="15" text-anchor="middle">`
    + `<text x="230" y="110" fill="none" stroke="#fff" stroke-opacity=".55" stroke-width="3" stroke-linejoin="round">${s}</text>`
    + `<text x="230" y="110" fill="#000" fill-opacity=".38">${s}</text></g></svg>`
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`
})
</script>

<style scoped>
.stage { position: relative; display: grid; place-items: center; min-height: 240px; max-height: 76vh; overflow: hidden; background: var(--surface-2); border-radius: 8px; }
.stage.fill { display: block; height: 72vh; }
.media { max-width: 100%; max-height: 72vh; display: block; user-select: none; -webkit-user-drag: none; }
.audio { width: min(520px, 90%); }
.pdf { width: 100%; height: 100%; border: 0; display: block; }
.text { margin: 0; padding: 14px; height: 100%; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 13.5px; }
.none { padding: 40px 12px; }
.mark { position: absolute; inset: 0; pointer-events: none; background-repeat: repeat; z-index: 2; }
.note { margin-top: 12px; font-size: 13px; }
</style>
