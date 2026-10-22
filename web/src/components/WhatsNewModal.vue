<template>
  <n-modal
    :show="whatsNew.show" preset="card" :title="title" style="width: min(520px, 94vw)" :auto-focus="false"
    @update:show="v => !v && close()"
  >
    <!-- a brand-new user -->
    <div v-if="whatsNew.mode === 'welcome'" class="welcome">
      <div class="big-icon"><n-icon :component="RocketOutline" size="34" /></div>
      <p class="lead">{{ t('guide.welcomeLead') }}</p>
      <p class="muted">{{ t('guide.welcomeHelp') }}</p>
    </div>

    <!-- everything, grouped by version (from the help page) -->
    <div v-else-if="whatsNew.mode === 'all'" class="all">
      <section v-for="r in whatsNew.releases" :key="r.version" class="rel">
        <h3>{{ t('guide.version', { v: r.version }) }}</h3>
        <div v-for="it in r.items" :key="it.id" class="row-item">
          <div class="icon"><n-icon :component="iconOf(it.icon)" size="20" /></div>
          <div class="grow">
            <div class="it-title">{{ loc(it.title) }}</div>
            <div class="it-text muted">{{ loc(it.text) }}</div>
            <n-button v-if="it.to" size="tiny" secondary class="show-btn" @click="showMe(it)">{{ t('guide.showMe') }}</n-button>
          </div>
        </div>
      </section>
    </div>

    <!-- what is new since the last visit: one slide per item -->
    <div v-else-if="slide" class="slides">
      <div class="slide" :key="slide.id">
        <div class="big-icon"><n-icon :component="iconOf(slide.icon)" size="34" /></div>
        <div class="ver muted">{{ t('guide.version', { v: slide.version }) }}</div>
        <h3 class="it-title big">{{ loc(slide.title) }}</h3>
        <p class="it-text">{{ loc(slide.text) }}</p>
        <n-button v-if="slide.to" secondary @click="showMe(slide)">{{ t('guide.showMe') }}</n-button>
      </div>
    </div>

    <template #footer>
      <div v-if="whatsNew.mode === 'welcome'" class="foot">
        <n-button @click="close">{{ t('guide.skipTour') }}</n-button>
        <n-button type="primary" @click="startTourNow">{{ t('guide.startTour') }}</n-button>
      </div>
      <div v-else-if="whatsNew.mode === 'all'" class="foot">
        <n-button type="primary" @click="close">{{ t('guide.close') }}</n-button>
      </div>
      <div v-else class="foot between">
        <n-button :style="{ visibility: at > 0 ? 'visible' : 'hidden' }" @click="at--">{{ t('guide.back') }}</n-button>
        <div class="dots" role="tablist">
          <button v-for="(s, i) in slides" :key="s.id" type="button" class="dot" :class="{ on: i === at }" :aria-label="`${i + 1} / ${slides.length}`" :aria-selected="i === at" @click="at = i" />
        </div>
        <n-button v-if="at < slides.length - 1" type="primary" @click="at++">{{ t('guide.next') }}</n-button>
        <n-button v-else type="primary" @click="close">{{ t('guide.gotIt') }}</n-button>
      </div>
    </template>
  </n-modal>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { NButton, NIcon, NModal } from 'naive-ui'
import { RocketOutline } from '@vicons/ionicons5'
import { iconOf } from '../guide/icons'
import { saveSeen, startFullTour, startTour, whatsNew } from '../guide/tour'
import { loc } from '../guide/util'
import { useAppStore } from '../store'

const { t } = useI18n()
const app = useAppStore()
const router = useRouter()


const slides = computed(() => whatsNew.releases.flatMap(r => r.items.map(it => ({ ...it, version: r.version }))))
const at = ref(0)
const slide = computed(() => slides.value[at.value])
watch(() => whatsNew.show, v => { if (v) at.value = 0 })

const title = computed(() => {
  if (whatsNew.mode === 'welcome') return t('guide.welcomeTitle', { name: app.appName })
  if (whatsNew.mode === 'all') return t('guide.allTitle')
  return t('guide.newTitle', { v: app.config.version || '' })
})

/** closed in any way: the news (or welcome) has been seen; the full list from the help page changes nothing */
function close() {
  if (!whatsNew.show) return
  whatsNew.show = false
  if (whatsNew.mode !== 'all') saveSeen(app.config.version)
}
function startTourNow() {
  close()
  startFullTour()
}
async function showMe(item) {
  close()
  if (item.to) { try { await router.push(item.to) } catch { /* stay */ } }
  if (item.tour) startTour(item.tour)
}
</script>

<style scoped>
.welcome, .slide { display: flex; flex-direction: column; align-items: center; text-align: center; gap: 8px; padding: 8px 4px; }
.big-icon { width: 64px; height: 64px; border-radius: 50%; display: grid; place-items: center; background: var(--primary-soft); color: var(--primary); }
.lead { margin: 8px 0 0; font-size: 15.5px; line-height: 1.6; overflow-wrap: anywhere; }
.welcome .muted { margin: 0; font-size: 14px; overflow-wrap: anywhere; }
.slides { min-height: 230px; display: flex; align-items: center; justify-content: center; }
.ver { font-size: 12.5px; margin-top: 4px; }
.it-title { font-weight: 600; font-size: 15px; overflow-wrap: anywhere; }
.it-title.big { font-size: 18px; margin: 0; }
.it-text { margin: 2px 0 8px; font-size: 14px; line-height: 1.55; overflow-wrap: anywhere; }
.all { max-height: min(60vh, 520px); overflow-y: auto; margin: 0 -4px; padding: 0 4px; }
.rel h3 { margin: 12px 0 6px; font-size: 14px; color: var(--primary); }
.rel:first-child h3 { margin-top: 0; }
.row-item { display: flex; gap: 12px; padding: 10px 0; border-top: 1px solid var(--border); }
.row-item .icon { flex: none; width: 36px; height: 36px; border-radius: 10px; display: grid; place-items: center; background: var(--primary-soft); color: var(--primary); }
.row-item .it-text { margin-bottom: 6px; }
.foot { display: flex; justify-content: flex-end; gap: 8px; flex-wrap: wrap; }
.foot.between { justify-content: space-between; align-items: center; flex-wrap: nowrap; }
.dots { display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; }
.dot { all: unset; box-sizing: border-box; width: 22px; height: 22px; padding: 7px; background-clip: content-box; border-radius: 50%; background-color: color-mix(in srgb, var(--muted) 45%, transparent); cursor: pointer; }
.dot.on { background-color: var(--primary); }
.dot:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
</style>
