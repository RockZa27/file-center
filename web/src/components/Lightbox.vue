<template>
  <teleport to="body">
    <div v-if="show && cur" ref="root" class="lb" role="dialog" aria-modal="true" :aria-label="cur.name" tabindex="-1" @keydown="onTrapKey">
      <div class="top">
        <div class="info">
          <span class="count">{{ index + 1 }} / {{ items.length }}</span>
          <span class="fname">{{ cur.name }}</span>
        </div>
        <div class="tools">
          <template v-if="items.length > 1">
            <button type="button" class="btn" :class="{ on: playing }" :title="playing ? t('lightbox.pause') : t('lightbox.play')" :aria-label="playing ? t('lightbox.pause') : t('lightbox.play')" :aria-pressed="playing" @click="togglePlay">
              <n-icon :component="playing ? PauseOutline : PlayOutline" :size="20" />
            </button>
            <span class="secs" role="group" :aria-label="t('lightbox.interval')">
              <button v-for="n in INTERVALS" :key="n" type="button" class="chip" :class="{ on: seconds === n }" :aria-pressed="seconds === n" @click="pickSeconds(n)">{{ t('lightbox.seconds', { n }) }}</button>
            </span>
          </template>
          <button v-if="cur.kind === 'image' && showing" type="button" class="btn" :title="scale > 1 ? t('lightbox.zoomOut') : t('lightbox.zoomIn')" :aria-label="scale > 1 ? t('lightbox.zoomOut') : t('lightbox.zoomIn')" @click="toggleZoom()">
            <n-icon :component="scale > 1 ? RemoveOutline : AddOutline" :size="20" />
          </button>
          <a v-if="downloadHref" class="btn" :href="downloadHref" :title="t('common.download')" :aria-label="t('common.download')" @click="stopPlay">
            <n-icon :component="DownloadOutline" :size="20" />
          </a>
          <button type="button" class="btn" :title="`${t('common.close')} (Esc)`" :aria-label="t('common.close')" @click="close">
            <n-icon :component="CloseOutline" :size="22" />
          </button>
        </div>
      </div>

      <div
        class="stage" :class="{ zoomed: scale > 1 }"
        @pointerdown="onDown" @pointermove="onMove" @pointerup="onUp" @pointercancel="onUp" @wheel.prevent="onWheel" @dblclick="onDblClick"
      >
        <video
          v-if="cur.kind === 'video' && videoSrc && !videoFailed" :key="cur.key" ref="video" class="media" :src="videoSrc" :poster="posterSrc || undefined"
          controls playsinline autoplay preload="metadata" @ended="onVideoEnded" @error="onVideoError"
        />
        <img
          v-else-if="showing" :key="`${cur.key}`" ref="img" class="media" :class="{ moving }" :src="showing" :alt="cur.name" draggable="false"
          :style="{ transform: `translate(${tx}px, ${ty}px) scale(${scale})` }" @load="onImgLoad" @error="onImgError"
        >
        <div v-else-if="cur.kind === 'video' && posterSrc" class="note-wrap">
          <img class="media" :src="posterSrc" :alt="cur.name" draggable="false">
        </div>
        <div v-if="notice" class="notice" role="status">{{ notice }}</div>
      </div>

      <template v-if="items.length > 1">
        <button type="button" class="nav prev" :disabled="index <= 0" :title="`${t('preview.previous')} (←)`" :aria-label="t('preview.previous')" @click="step(-1)">
          <n-icon :component="ChevronBackOutline" :size="28" />
        </button>
        <button type="button" class="nav next" :disabled="index >= items.length - 1" :title="`${t('preview.next')} (→)`" :aria-label="t('preview.next')" @click="step(1)">
          <n-icon :component="ChevronForwardOutline" :size="28" />
        </button>
      </template>
    </div>
  </teleport>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { NIcon } from 'naive-ui'
import { AddOutline, ChevronBackOutline, ChevronForwardOutline, CloseOutline, DownloadOutline, PauseOutline, PlayOutline, RemoveOutline } from '@vicons/ionicons5'
import { canShowOriginal } from '../media'

// A full-screen viewer for the pictures and videos of a folder. The picture opens at once from its 1024 px preview
// and is swapped for the original when that has arrived. The parent says where the files are (thumbUrl, fileUrl,
// downloadUrl): the same viewer serves the file browser and the download-link page.
const props = defineProps({
  show: Boolean,
  /** [{ key, name, kind: 'image' | 'video' }] in the order shown */
  items: { type: Array, default: () => [] },
  index: { type: Number, default: 0 },
  /** (item, 256 | 1024) => url of the small picture, '' when there is none to ask for */
  thumbUrl: { type: Function, default: () => '' },
  /** (item) => url of the file itself, to show or play */
  fileUrl: { type: Function, required: true },
  /** (item) => url to save the file; '' hides the button */
  downloadUrl: { type: Function, default: () => '' },
  /** false: only the preview is shown (the viewer may read, not download) */
  canOriginal: { type: Boolean, default: true },
  /** false: the original of a picture is fetched only when it is zoomed (a download link counts every download) */
  autoOriginal: { type: Boolean, default: true },
})
const emit = defineEmits(['update:show', 'update:index'])
const { t } = useI18n()

const INTERVALS = [3, 5, 10]
const root = ref(null)
const img = ref(null)
const video = ref(null)

const playing = ref(false)
const seconds = ref(5)
let timer = null

const cur = computed(() => props.items[props.index] || null)
const downloadHref = computed(() => (props.canOriginal && cur.value ? props.downloadUrl(cur.value) : ''))
const videoSrc = computed(() => (props.canOriginal && cur.value?.kind === 'video' ? props.fileUrl(cur.value) : ''))
const posterSrc = computed(() => (cur.value ? props.thumbUrl(cur.value, 1024) : ''))

// ───── the picture: preview first, original when it is in ─────
const thumbBad = ref(false)
const fullReady = ref(false)
const failedAll = ref(false)
const videoFailed = ref(false)
const scale = ref(1)
const tx = ref(0)
const ty = ref(0)
const moving = ref(false)
let loader = null

const originalSrc = computed(() => {
  const it = cur.value
  if (!it || it.kind !== 'image' || !props.canOriginal || !canShowOriginal(it.name)) return ''
  return props.fileUrl(it)
})
const wantOriginal = computed(() => !!originalSrc.value && (props.autoOriginal || scale.value > 1))
const showing = computed(() => {
  if (!cur.value || cur.value.kind !== 'image' || failedAll.value) return ''
  const small = thumbBad.value ? '' : posterSrc.value
  if (fullReady.value && originalSrc.value) return originalSrc.value
  return small || originalSrc.value
})
const notice = computed(() => {
  if (!cur.value) return ''
  if (cur.value.kind === 'video') {
    if (!props.canOriginal) return t('lightbox.noPlay')
    return videoFailed.value ? t('lightbox.noVideo') : ''
  }
  return failedAll.value ? t('lightbox.noImage') : ''
})

function preloadOriginal() {
  if (loader) { loader.onload = null; loader.src = ''; loader = null }
  fullReady.value = false
  if (!wantOriginal.value) return
  const want = cur.value.key
  const im = new Image()
  im.decoding = 'async'
  im.onload = () => { if (cur.value?.key === want) fullReady.value = true }
  // the preview stays when the original cannot be read
  im.onerror = () => { if (cur.value?.key === want && thumbBad.value) failedAll.value = true }
  im.src = originalSrc.value
  loader = im
}

let armed = false
function onImgLoad() { armTimer() }
function onImgError() {
  if (showing.value === originalSrc.value || !originalSrc.value) {
    failedAll.value = true
  } else {
    // no preview: go straight to the original
    thumbBad.value = true
    if (!wantOriginal.value) failedAll.value = true
  }
  armTimer()
}

function resetView() {
  scale.value = 1
  tx.value = 0
  ty.value = 0
  moving.value = false
}

watch(() => [props.show, cur.value?.key], () => {
  thumbBad.value = false
  failedAll.value = false
  videoFailed.value = false
  armed = false
  clearTimeout(timer)
  resetView()
  if (!props.show || !cur.value) return
  preloadOriginal()
  warmNeighbours()
}, { immediate: true })

watch(wantOriginal, v => { if (v && !fullReady.value && !loader) preloadOriginal() })

/** the preview of the next picture is fetched while this one is looked at */
function warmNeighbours() {
  for (const d of [1, -1]) {
    const it = props.items[props.index + d]
    if (it?.kind === 'image') {
      const u = props.thumbUrl(it, 1024)
      if (u) new Image().src = u
    }
  }
}

// ───── moving through the folder ─────
function go(i) {
  if (i < 0 || i >= props.items.length) return
  emit('update:index', i)
}
/** the person pressed something: a slideshow stops, it does not run on under their hands */
function step(d) {
  stopPlay()
  go(props.index + d)
}
function close() {
  stopPlay()
  emit('update:show', false)
}

// ───── slideshow: stops at the last one ─────
function stopPlay() {
  playing.value = false
  clearTimeout(timer)
}
function togglePlay() {
  if (playing.value) return stopPlay()
  // from the last one there is nowhere to go: start over
  if (props.index >= props.items.length - 1) go(0)
  playing.value = true
  armed = false
  armTimer()
}
function pickSeconds(n) {
  seconds.value = n
  if (!playing.value) togglePlay()
  else { armed = false; armTimer() }
}
/** the time of a picture counts from when it is on screen; a video runs to its end */
function armTimer() {
  if (!playing.value || armed || !cur.value) return
  // a video that plays runs to its end; one that cannot be played (or is not to be) gets the time of a picture
  if (cur.value.kind === 'video' && !videoFailed.value && videoSrc.value) return
  armed = true
  clearTimeout(timer)
  timer = setTimeout(advance, seconds.value * 1000)
}
function advance() {
  if (!playing.value) return
  if (props.index >= props.items.length - 1) return stopPlay()
  go(props.index + 1)
}
function onVideoEnded() { if (playing.value) advance() }

// a video as the next one has no image load to start the clock: its end does
watch(() => [playing.value, cur.value?.key], () => {
  if (!playing.value || !cur.value) return
  nextTick(() => { if (cur.value?.kind === 'video' ? !videoSrc.value : !showing.value) armTimer() })
})
function onVideoError() {
  videoFailed.value = true
  armTimer()
}

// ───── zoom, pan, swipe ─────
const pointers = new Map()
let pinch = null
let drag = null
let lastTap = { t: 0, x: 0, y: 0 }
let lastType = 'mouse'
const MAX_SCALE = 6

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
function limits() {
  const el = img.value
  if (!el) return { x: 0, y: 0 }
  return { x: Math.max(0, (el.clientWidth * scale.value - window.innerWidth) / 2 + 40), y: Math.max(0, (el.clientHeight * scale.value - window.innerHeight) / 2 + 40) }
}
function fit() {
  if (scale.value <= 1) { tx.value = 0; ty.value = 0; return }
  const l = limits()
  tx.value = clamp(tx.value, -l.x, l.x)
  ty.value = clamp(ty.value, -l.y, l.y)
}
function setScale(s, cx, cy) {
  const old = scale.value
  const next = clamp(s, 1, MAX_SCALE)
  if (next === old) return
  // keep the point under the finger/cursor where it is
  if (cx !== undefined) {
    const mx = cx - window.innerWidth / 2
    const my = cy - window.innerHeight / 2
    tx.value = mx - ((mx - tx.value) / old) * next
    ty.value = my - ((my - ty.value) / old) * next
  }
  scale.value = next
  fit()
}
function toggleZoom(x, y) {
  stopPlay()
  if (scale.value > 1) { resetView(); return }
  setScale(2.5, x ?? window.innerWidth / 2, y ?? window.innerHeight / 2)
}
function onWheel(e) {
  if (cur.value?.kind !== 'image') return
  stopPlay()
  setScale(scale.value * Math.exp(-e.deltaY * 0.0022), e.clientX, e.clientY)
}
function onDblClick(e) {
  if (cur.value?.kind !== 'image' || lastType === 'touch') return
  toggleZoom(e.clientX, e.clientY)
}
function onDown(e) {
  lastType = e.pointerType || 'mouse'
  if (!cur.value || e.target.closest?.('button, a')) return
  const isImage = cur.value.kind === 'image'
  // a video keeps its own controls (the bottom strip) and its own taps; a swipe above them still turns the page
  if (!isImage && (e.clientY > window.innerHeight - 96 || pointers.size)) return
  if (isImage) e.currentTarget.setPointerCapture?.(e.pointerId)
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()]
    pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, s: scale.value }
    drag = null
    stopPlay()
  } else if (pointers.size === 1) {
    drag = { x: e.clientX, y: e.clientY, tx: tx.value, ty: ty.value, at: Date.now(), moved: false }
  }
}
function onMove(e) {
  const p = pointers.get(e.pointerId)
  if (!p) return
  p.x = e.clientX
  p.y = e.clientY
  if (pinch && pointers.size >= 2) {
    const [a, b] = [...pointers.values()]
    const d = Math.hypot(a.x - b.x, a.y - b.y)
    moving.value = true
    setScale(pinch.s * (d / pinch.d), (a.x + b.x) / 2, (a.y + b.y) / 2)
    return
  }
  if (!drag) return
  const dx = e.clientX - drag.x
  const dy = e.clientY - drag.y
  if (Math.abs(dx) + Math.abs(dy) > 6) drag.moved = true
  if (scale.value > 1) {
    moving.value = true
    tx.value = drag.tx + dx
    ty.value = drag.ty + dy
    fit()
  }
}
function onUp(e) {
  const p = pointers.get(e.pointerId)
  pointers.delete(e.pointerId)
  if (pinch) {
    if (pointers.size < 2) pinch = null
    if (scale.value <= 1.02) resetView()
    drag = null
    return
  }
  moving.value = false
  if (!p || !drag) return
  const d = drag
  drag = null
  const dx = e.clientX - d.x
  const dy = e.clientY - d.y
  if (e.type === 'pointercancel') return
  // a swipe along the picture (it is not zoomed): the next or the previous one
  if (scale.value <= 1 && Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5 && Date.now() - d.at < 900) {
    step(dx < 0 ? 1 : -1)
    return
  }
  // two quick taps on a touch screen: zoom (a mouse has its own double click)
  if (e.pointerType === 'touch' && !d.moved && cur.value?.kind === 'image') {
    const now = Date.now()
    if (now - lastTap.t < 350 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 30) {
      lastTap = { t: 0, x: 0, y: 0 }
      toggleZoom(e.clientX, e.clientY)
    } else lastTap = { t: now, x: e.clientX, y: e.clientY }
  }
}

// ───── keys, focus ─────
function focusables() {
  return [...(root.value?.querySelectorAll('button:not([disabled]), a[href], video[controls]') || [])]
}
/** Tab stays inside the viewer */
function onTrapKey(e) {
  if (e.key !== 'Tab') return
  const list = focusables()
  if (!list.length) { e.preventDefault(); root.value?.focus(); return }
  const first = list[0]
  const last = list[list.length - 1]
  const active = document.activeElement
  if (e.shiftKey && (active === first || active === root.value)) { e.preventDefault(); last.focus() } else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus() }
}
function onKey(e) {
  if (!props.show || e.ctrlKey || e.metaKey || e.altKey) return
  const k = e.key
  const onVideo = e.target?.tagName === 'VIDEO'
  if (k === 'Escape') { e.preventDefault(); e.stopPropagation(); close() } else if (k === 'ArrowRight' && !onVideo) { e.preventDefault(); step(1) } else if (k === 'ArrowLeft' && !onVideo) { e.preventDefault(); step(-1) } else if ((k === '+' || k === '=') && cur.value?.kind === 'image') { e.preventDefault(); stopPlay(); setScale(scale.value * 1.4, window.innerWidth / 2, window.innerHeight / 2) } else if (k === '-' && cur.value?.kind === 'image') { e.preventDefault(); stopPlay(); setScale(scale.value / 1.4, window.innerWidth / 2, window.innerHeight / 2) } else if (k === '0') { resetView() } else if (k === 'Home') { e.preventDefault(); step(-props.index) } else if (k === 'End') { e.preventDefault(); step(props.items.length - 1 - props.index) } else if (k === ' ' && e.target?.tagName !== 'BUTTON' && !onVideo && props.items.length > 1) { e.preventDefault(); togglePlay() }
}

let opener = null
let overflowWas = ''
let isOpen = false
watch(() => props.show, async on => {
  if (on) {
    isOpen = true
    opener = document.activeElement
    overflowWas = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', onKey, true)
    await nextTick()
    root.value?.focus()
  } else if (isOpen) cleanup()
}, { immediate: true })

function cleanup() {
  isOpen = false
  window.removeEventListener('keydown', onKey, true)
  document.body.style.overflow = overflowWas
  clearTimeout(timer)
  playing.value = false
  pointers.clear()
  pinch = null
  drag = null
  if (loader) { loader.onload = null; loader.src = ''; loader = null }
  if (opener && document.contains(opener)) opener.focus?.()
  opener = null
}
onBeforeUnmount(() => { if (isOpen) cleanup() })
</script>

<style scoped>
.lb { position: fixed; inset: 0; z-index: 2500; background: rgba(6, 6, 8, 0.98); color: #f3f4f6; display: flex; flex-direction: column; outline: none; overscroll-behavior: contain; }
.top { position: absolute; top: 0; left: 0; right: 0; z-index: 3; display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; padding: 10px 12px; background: linear-gradient(rgba(0, 0, 0, 0.7), rgba(0, 0, 0, 0)); }
.info { flex: 1 1 200px; min-width: 0; display: flex; align-items: baseline; gap: 10px; }
.count { flex: none; font-weight: 600; font-variant-numeric: tabular-nums; }
.fname { min-width: 0; overflow-wrap: anywhere; font-size: 14px; opacity: 0.9; line-height: 1.35; }
.tools { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-left: auto; }
.btn { all: unset; box-sizing: border-box; display: inline-grid; place-items: center; width: 40px; height: 40px; border-radius: 50%; cursor: pointer; color: #f3f4f6; background: rgba(255, 255, 255, 0.1); }
.btn:hover { background: rgba(255, 255, 255, 0.22); }
.btn.on { background: var(--primary); }
.btn:focus-visible, .chip:focus-visible, .nav:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
.secs { display: inline-flex; gap: 4px; }
.chip { all: unset; box-sizing: border-box; cursor: pointer; padding: 0 10px; height: 30px; display: inline-grid; place-items: center; border-radius: 15px; font-size: 12.5px; background: rgba(255, 255, 255, 0.1); }
.chip:hover { background: rgba(255, 255, 255, 0.22); }
.chip.on { background: rgba(255, 255, 255, 0.85); color: #111; }
.stage { position: absolute; inset: 0; display: grid; grid-template: minmax(0, 1fr) / minmax(0, 1fr); place-items: center; overflow: hidden; touch-action: none; user-select: none; }
.stage.zoomed { cursor: grab; }
.media { max-width: 100%; max-height: 100%; width: auto; height: auto; object-fit: contain; transition: transform 0.12s ease-out; -webkit-user-drag: none; }
.media.moving { transition: none; }
video.media { width: 100%; height: 100%; background: #000; }
.note-wrap { display: grid; place-items: center; width: 100%; height: 100%; }
.notice { position: absolute; left: 50%; bottom: 56px; transform: translateX(-50%); max-width: calc(100% - 32px); padding: 8px 14px; border-radius: 10px; background: rgba(0, 0, 0, 0.75); font-size: 14px; text-align: center; z-index: 2; }
.nav { all: unset; box-sizing: border-box; position: absolute; top: 50%; z-index: 3; transform: translateY(-50%); display: grid; place-items: center; width: 48px; height: 64px; cursor: pointer; color: #fff; background: rgba(0, 0, 0, 0.35); border-radius: 12px; }
.nav:hover { background: rgba(0, 0, 0, 0.6); }
.nav:disabled { opacity: 0.25; cursor: default; }
.prev { left: 8px; }
.next { right: 8px; }
@media (max-width: 640px) {
  .nav { width: 36px; height: 56px; }
  .prev { left: 2px; }
  .next { right: 2px; }
  .top { padding: 8px; }
  .fname { font-size: 13px; }
}
@media (prefers-reduced-motion: reduce) { .media { transition: none; } }
</style>
