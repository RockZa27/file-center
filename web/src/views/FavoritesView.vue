<template>
  <div class="page">
    <page-header :title="t('favorites.title')" :description="t('favorites.hint')" />
    <n-tabs v-model:value="tab" type="line">
      <n-tab name="favorites">{{ t('favorites.tabFavorites') }}</n-tab>
      <n-tab name="recent">{{ t('favorites.tabRecent') }}</n-tab>
    </n-tabs>
    <list-panel class="box" :loading="loading" :count="rows.length" :empty="tab === 'favorites' ? t('favorites.emptyFavorites') : t('favorites.emptyRecent')">
      <list-row v-for="r in rows" :key="`${r.space}:${r.path}`" @open="openIt(r)">
        <template #icon><file-icon :item="r" :size="24" /></template>
        <template #title>{{ r.name }}</template>
        <template #sub>
          <span>{{ parentPath(r.path) }}</span>
          <span>{{ spaceLabel(r.space) }}</span>
          <span v-if="tab === 'recent' && r.at" :title="formatDate(r.at)">{{ ago(r.at) }} · {{ formatDate(r.at) }}</span>
        </template>
        <template #actions>
          <n-button v-if="isFav(r)" quaternary circle :title="t('files.removeFavorite')" :aria-label="t('files.removeFavorite')" @click="unstar(r)">
            <template #icon><n-icon :component="Star" color="var(--star)" /></template>
          </n-button>
          <n-button v-else quaternary circle :title="t('files.addFavorite')" :aria-label="t('files.addFavorite')" @click="star(r)">
            <template #icon><n-icon :component="StarOutline" /></template>
          </n-button>
        </template>
      </list-row>
    </list-panel>
  </div>
</template>

<script setup>
import PageHeader from '../components/PageHeader.vue'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { NButton, NIcon, NTab, NTabs } from 'naive-ui'
import { Star, StarOutline } from '@vicons/ionicons5'
import { relativeTime } from '../account-utils'
import { api } from '../api'
import FileIcon from '../components/FileIcon.vue'
import ListPanel from '../components/ListPanel.vue'
import ListRow from '../components/ListRow.vue'
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
.box { margin-top: 4px; }
</style>
