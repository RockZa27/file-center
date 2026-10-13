<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h1>{{ t('favorites.title') }}</h1>
        <p>{{ t('favorites.hint') }}</p>
      </div>
    </div>
    <n-tabs v-model:value="tab" type="line">
      <n-tab name="favorites">{{ t('favorites.tabFavorites') }}</n-tab>
      <n-tab name="recent">{{ t('favorites.tabRecent') }}</n-tab>
    </n-tabs>
    <div class="surface box">
      <n-spin :show="loading && !rows.length">
        <n-empty v-if="!loading && !rows.length" class="empty" :description="tab === 'favorites' ? t('favorites.emptyFavorites') : t('favorites.emptyRecent')" />
        <ul v-else class="list">
          <li v-for="r in rows" :key="`${r.space}:${r.path}`" class="row">
            <button type="button" class="open" @click="openIt(r)">
              <file-icon :item="r" :size="24" />
              <span class="text">
                <span class="nm">{{ r.name }}</span>
                <span class="muted sub">
                  <span class="dir">{{ parentPath(r.path) }}</span>
                  <span>{{ spaceLabel(r.space) }}</span>
                  <span v-if="tab === 'recent' && r.at" :title="formatDate(r.at)">{{ ago(r.at) }} · {{ formatDate(r.at) }}</span>
                </span>
              </span>
            </button>
            <n-button v-if="isFav(r)" quaternary circle :title="t('files.removeFavorite')" @click="unstar(r)">
              <template #icon><n-icon :component="Star" color="#f59e0b" /></template>
            </n-button>
            <n-button v-else quaternary circle :title="t('files.addFavorite')" @click="star(r)">
              <template #icon><n-icon :component="StarOutline" /></template>
            </n-button>
          </li>
        </ul>
      </n-spin>
    </div>
  </div>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { NButton, NEmpty, NIcon, NSpin, NTab, NTabs } from 'naive-ui'
import { Star, StarOutline } from '@vicons/ionicons5'
import { relativeTime } from '../account-utils'
import { api } from '../api'
import FileIcon from '../components/FileIcon.vue'
import { useFeedback } from '../composables'
import { useAppStore } from '../store'
import { formatDate, parentPath } from '../utils'

const { t, locale } = useI18n()
const router = useRouter()
const app = useAppStore()
const fb = useFeedback()

const tab = ref('favorites')
const lists = ref({ favorites: [], recent: [] })
const loading = ref(false)
const rows = computed(() => lists.value[tab.value])
const ago = iso => relativeTime(Date.parse(iso), Date.now(), locale.value)
const spaceLabel = s => (s === 'public' ? t('favorites.spacePublic') : t('favorites.spaceHome'))
const isFav = r => app.isFavorite(r.space, r.path)

async function load() {
  loading.value = true
  try {
    const [f, r] = await Promise.all([api.favorites(), api.recent()])
    lists.value = { favorites: f.items, recent: r.items }
  } catch (e) { fb.fail(e) } finally { loading.value = false }
}
load()
app.loadFavorites()
// coming back to a tab shows what the other one changed
watch(tab, load)

/** the folder of the file with the file selected (a folder opens itself) */
function openIt(r) {
  const name = r.space === 'public' ? 'shared' : 'files'
  if (r.type === 'dir') return router.push({ name, query: r.path === '/' ? {} : { path: r.path } })
  const dir = parentPath(r.path)
  router.push({ name, query: { ...(dir === '/' ? {} : { path: dir }), select: r.path } })
}

async function unstar(r) {
  try {
    await app.toggleFavorite(r.space, r.path)
    lists.value = { ...lists.value, favorites: lists.value.favorites.filter(f => !(f.space === r.space && f.path === r.path)) }
    fb.ok(t('favorites.removed'))
  } catch (e) { fb.fail(e) }
}
async function star(r) {
  try { await app.toggleFavorite(r.space, r.path); fb.ok(t('favorites.added')) } catch (e) { fb.fail(e) }
}
</script>

<style scoped>
.box { margin-top: 4px; min-height: 160px; }
.empty { padding: 48px 16px; }
.list { list-style: none; margin: 0; padding: 0; }
.row { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-top: 1px solid var(--border); }
.row:first-child { border-top: 0; }
.open { all: unset; box-sizing: border-box; flex: 1; min-width: 0; display: flex; align-items: center; gap: 12px; padding: 6px; border-radius: 8px; cursor: pointer; }
.open:hover, .open:focus-visible { background: var(--surface-2); }
.text { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.nm { font-weight: 500; overflow-wrap: anywhere; }
.sub { font-size: 12.5px; display: flex; flex-wrap: wrap; gap: 2px 12px; }
.dir { overflow-wrap: anywhere; }
</style>
