<template>
  <teleport to="body">
    <div v-if="tour.active && step" class="tour-root" :class="{ dock: narrow }">
      <!-- takes the clicks while the tour is on, so nothing behind it changes -->
      <div class="tour-block" />
      <div class="tour-hole" :class="{ none: !hole }" :style="holeStyle" />
      <section
        ref="card" class="tour-card" :style="cardStyle" role="dialog" aria-live="polite" :aria-label="loc(step.title)"
        @click.stop
      >
        <header class="tour-head">
          <div class="tour-title">{{ loc(step.title) }}</div>
          <button type="button" class="tour-x" :aria-label="t('guide.close')" :title="t('guide.close')" @click="end">
            <n-icon :component="CloseOutline" size="18" />
          </button>
        </header>
        <p class="tour-text">{{ loc(step.text) }}</p>
        <footer class="tour-foot">
          <span class="tour-count muted">{{ t('guide.stepOf', { n: stepNumber(), total: stepTotal() }) }}</span>
          <span class="tour-btns">
            <n-button v-if="!last" quaternary size="small" @click="end">{{ t('guide.skip') }}</n-button>
            <n-button size="small" :disabled="stepNumber() <= 1" @click="prevStep">{{ t('guide.back') }}</n-button>
            <n-button ref="nextBtn" type="primary" size="small" @click="last ? end() : nextStep()">{{ last ? t('guide.done') : t('guide.next') }}</n-button>
          </span>
        </footer>
      </section>
    </div>
  </teleport>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { NButton, NIcon } from 'naive-ui'
import { CloseOutline } from '@vicons/ionicons5'
import { end, findTarget, isLast, nextStep, prevStep, stepNumber, stepTotal, tour } from '../guide/tour'
import { loc } from '../guide/util'

const { t } = useI18n()
const card = ref(null)
const nextBtn = ref(null)
const rect = ref(null)
const view = ref({ w: window.innerWidth, h: window.innerHeight })
const cardSize = ref({ w: 0, h: 0 })
const inMenu = ref(false)

const step = computed(() => tour.steps[tour.index])
const last = computed(() => isLast())
const narrow = computed(() => view.value.w <= 640)

const PAD = 6
const hole = computed(() => {
  const r = rect.value
  if (!r) return null
  // a target taller than the screen is lit as far as it shows
  const left = Math.max(0, r.left - PAD), top = Math.max(0, r.top - PAD)
  const right = Math.min(view.value.w, r.right + PAD), bottom = Math.min(view.value.h, r.bottom + PAD)
  return { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) }
})
const holeStyle = computed(() => (hole.value
  ? { left: hole.value.left + 'px', top: hole.value.top + 'px', width: hole.value.width + 'px', height: hole.value.height + 'px' }
  : { left: '50%', top: '50%' }))

const cardStyle = computed(() => {
  const { w: vw, h: vh } = view.value
  if (narrow.value) {
    // docked to the bottom, or to the top when the target is in the lower half of the screen
    const lower = hole.value && hole.value.top + hole.value.height / 2 > vh / 2
    return { left: '8px', right: '8px', [lower ? 'top' : 'bottom']: '8px' }
  }
  const w = Math.min(360, vw - 24), h = cardSize.value.h || 180
  const clampX = x => Math.min(Math.max(12, x), vw - w - 12)
  const clampY = y => Math.min(Math.max(12, y), vh - h - 12)
  const hl = hole.value
  if (!hl) return { width: w + 'px', left: clampX((vw - w) / 2) + 'px', top: clampY((vh - h) / 2) + 'px' }
  const gap = 12
  const below = { left: clampX(hl.left), top: hl.top + hl.height + gap }
  const above = { left: clampX(hl.left), top: hl.top - gap - h }
  const right = { left: hl.left + hl.width + gap, top: clampY(hl.top) }
  const left = { left: hl.left - gap - w, top: clampY(hl.top) }
  const fitsV = p => p.top >= 12 && p.top + h <= vh - 12
  const fitsH = p => p.left >= 12 && p.left + w <= vw - 12
  const order = inMenu.value ? [right, below, above, left] : [below, above, right, left]
  let pos = order.find(p => (p === below || p === above ? fitsV(p) : fitsH(p)))
  // nowhere beside it (a target as tall as the page): inside the target, near its top
  if (!pos) pos = { left: clampX(hl.left + hl.width / 2 - w / 2), top: clampY(hl.top + 16) }
  return { width: w + 'px', left: pos.left + 'px', top: pos.top + 'px' }
})

let raf = 0
let lastKey = ''
function tick() {
  raf = requestAnimationFrame(tick)
  if (!tour.active) return
  const w = window.innerWidth, h = window.innerHeight
  const el = tour.targets.length ? findTarget(tour.targets) : null
  const r = el ? el.getBoundingClientRect() : null
  const c = card.value
  const cw = c ? c.offsetWidth : 0, ch = c ? c.offsetHeight : 0
  const menu = !!el?.closest('.sidebar')
  const key = [w, h, r && [r.left, r.top, r.right, r.bottom].map(Math.round).join(','), cw, ch, menu].join('|')
  if (key === lastKey) return
  lastKey = key
  view.value = { w, h }
  rect.value = r ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom } : null
  cardSize.value = { w: cw, h: ch }
  inMenu.value = menu
}

// the keys belong to the tour while it is on: Esc closes, the arrows walk, nothing reaches the file list behind it
function onKey(e) {
  if (!tour.active || e.isComposing) return
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); end(); return }
  if (e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); last.value ? end() : nextStep(); return }
  if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); prevStep(); return }
  if (e.key === 'Tab' || card.value?.contains(e.target)) return
  e.stopPropagation()
}

watch(() => tour.index, async () => {
  await nextTick()
  nextBtn.value?.$el?.focus?.({ preventScroll: true })
})
watch(() => tour.targets, () => { lastKey = '' })

onMounted(() => {
  raf = requestAnimationFrame(tick)
  window.addEventListener('keydown', onKey, true)
})
onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
  window.removeEventListener('keydown', onKey, true)
  tour.active = false
})
</script>

<style scoped>
.tour-root { position: fixed; inset: 0; z-index: 3000; pointer-events: none; }
.tour-block { position: absolute; inset: 0; pointer-events: auto; }
.tour-hole {
  position: fixed; border-radius: 10px; pointer-events: none;
  box-shadow: 0 0 0 9999px rgba(8, 10, 16, 0.62), 0 0 0 2px var(--primary);
  transition: left 0.18s ease, top 0.18s ease, width 0.18s ease, height 0.18s ease;
}
.tour-hole.none { width: 0; height: 0; box-shadow: 0 0 0 9999px rgba(8, 10, 16, 0.62); }
.tour-card {
  position: fixed; pointer-events: auto; max-width: calc(100vw - 16px);
  background: var(--surface); color: var(--text); border: 1px solid var(--border); border-radius: var(--radius);
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.3); padding: 14px 16px;
}
.tour-head { display: flex; align-items: flex-start; gap: 8px; }
.tour-title { flex: 1; min-width: 0; font-weight: 600; font-size: 15.5px; overflow-wrap: anywhere; }
.tour-x { all: unset; cursor: pointer; display: grid; place-items: center; width: 26px; height: 26px; border-radius: 6px; color: var(--muted); flex: none; }
.tour-x:hover, .tour-x:focus-visible { background: var(--surface-2); color: var(--text); }
.tour-text { margin: 6px 0 12px; font-size: 14px; line-height: 1.55; overflow-wrap: anywhere; }
.tour-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
.tour-count { font-size: 12.5px; }
.tour-btns { display: flex; align-items: center; gap: 6px; margin-left: auto; }
@media (prefers-reduced-motion: reduce) { .tour-hole { transition: none; } }
</style>
