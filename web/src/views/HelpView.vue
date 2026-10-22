<template>
  <div class="page">
    <page-header :title="t('nav.help')" :description="t('help.subtitle')">
      <template #actions>
        <n-button secondary @click="startFullTour"><template #icon><n-icon :component="PlayCircleOutline" /></template>{{ t('help.restartTour') }}</n-button>
        <n-button secondary @click="showAll"><template #icon><n-icon :component="SparklesOutline" /></template>{{ t('help.whatsNew') }}</n-button>
      </template>
    </page-header>

    <n-input v-model:value="query" clearable class="search" :placeholder="t('help.search')" :aria-label="t('help.search')">
      <template #prefix><n-icon :component="SearchOutline" /></template>
    </n-input>

    <div v-if="!shown.length" class="surface empty muted">{{ t('help.none', { q: query }) }}</div>
    <div v-else class="grid">
      <article v-for="tp in shown" :key="tp.id" class="surface card" :data-topic="tp.id">
        <header class="card-head">
          <span class="icon"><n-icon :component="iconOf(tp.icon)" size="20" /></span>
          <h2>{{ loc(tp.title) }}</h2>
          <span v-if="tp.roles[0] !== 'user'" class="role-tag">{{ tp.roles[0] === 'admin' ? t('help.forAdmin') : t('help.forStaff') }}</span>
        </header>
        <p v-for="(line, i) in lines(tp)" :key="i" class="line">{{ line }}</p>
        <dl v-if="tp.special === 'shortcuts'" class="keys">
          <template v-for="k in shortcuts" :key="k.keys">
            <dt><kbd>{{ k.keys }}</kbd></dt><dd>{{ t('keys.' + k.text) }}</dd>
          </template>
        </dl>
        <div v-if="tp.tour || tp.to" class="card-foot">
          <n-button v-if="tp.tour" size="small" secondary @click="showMe(tp)">{{ t('guide.showMe') }}</n-button>
          <n-button v-else size="small" secondary @click="router.push(tp.to)">{{ t('help.open') }}</n-button>
        </div>
      </article>
    </div>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { NButton, NIcon, NInput } from 'naive-ui'
import { PlayCircleOutline, SearchOutline, SparklesOutline } from '@vicons/ionicons5'
import PageHeader from '../components/PageHeader.vue'
import { iconOf } from '../guide/icons'
import { releasesFor } from '../guide/releases'
import { openWhatsNew, startFullTour, startTour } from '../guide/tour'
import { topicsFor } from '../guide/topics'
import { loc } from '../guide/util'
import { useAppStore } from '../store'

const { t } = useI18n()
const app = useAppStore()
const router = useRouter()
const query = ref('')

const shortcuts = [
  { keys: 'Enter', text: 'open' }, { keys: 'Backspace', text: 'up' }, { keys: '↑ / ↓', text: 'move' }, { keys: 'Shift+↑/↓', text: 'extend' },
  { keys: 'Ctrl/⌘+A', text: 'all' }, { keys: 'Esc', text: 'clear' }, { keys: 'F2', text: 'rename' }, { keys: 'Del', text: 'delete' },
  { keys: 'Ctrl/⌘+C', text: 'copy' }, { keys: 'Ctrl/⌘+X', text: 'cut' }, { keys: 'Ctrl/⌘+V', text: 'paste' }, { keys: '/', text: 'search' }, { keys: '?', text: 'help' },
]

const topics = computed(() => topicsFor(app.user?.role, { webdav: !!app.config.webdav }))
const lines = tp => (loc(tp.text) || []).map(s => s.replaceAll('{host}', location.origin))
const shown = computed(() => {
  const q = query.value.trim().toLowerCase()
  if (!q) return topics.value
  // both languages are searched, so a Thai word finds the topic on an English page too
  return topics.value.filter(tp => [tp.title, tp.keywords, ...[tp.text.th, tp.text.en].map(a => a.join(' '))].some(o => (typeof o === 'string' ? o : `${o?.th} ${o?.en}`).toLowerCase().includes(q)))
})

async function showMe(tp) {
  if (tp.to) { try { await router.push(tp.to) } catch { /* stay */ } }
  startTour(tp.tour)
}
const showAll = () => openWhatsNew('all', releasesFor(app.user?.role, null, app.config.version, { webdav: !!app.config.webdav }))
</script>

<style scoped>
.search { max-width: 480px; margin-bottom: 16px; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 340px), 1fr)); gap: 14px; align-items: start; }
.card { padding: 16px; min-width: 0; }
.card-head { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
.card-head h2 { margin: 0; font-size: 16px; font-weight: 600; flex: 1; min-width: 0; overflow-wrap: anywhere; }
.icon { flex: none; width: 34px; height: 34px; border-radius: 10px; display: grid; place-items: center; background: var(--primary-soft); color: var(--primary); }
.role-tag { flex: none; font-size: 11.5px; padding: 2px 8px; border-radius: 999px; background: var(--surface-2); border: 1px solid var(--border); color: var(--muted); }
.line { margin: 0 0 8px; font-size: 14px; line-height: 1.6; overflow-wrap: anywhere; }
.keys { display: grid; grid-template-columns: auto 1fr; gap: 6px 12px; margin: 8px 0 0; font-size: 13.5px; align-items: center; }
.keys dt, .keys dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
kbd { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px; padding: 2px 6px; border-radius: 6px; background: var(--surface-2); border: 1px solid var(--border); white-space: nowrap; }
.card-foot { margin-top: 10px; }
.empty { padding: 32px 20px; text-align: center; overflow-wrap: anywhere; }
</style>
