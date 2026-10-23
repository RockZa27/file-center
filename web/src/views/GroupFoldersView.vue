<template>
  <div class="page">
    <!-- one group's folder -->
    <template v-if="id">
      <div>
        <n-skeleton v-if="loading && !current" class="banner" :height="64" :sharp="false" />
        <n-alert v-else-if="current" type="info" :show-icon="true" class="banner">
          <div class="banner-row">
            <span class="banner-text">
              {{ t('groups.viewing', { name: current.name }) }}
              <n-tag size="small" round :bordered="false" :type="current.perms === 'edit' ? 'success' : 'default'">{{ permLabel(current.perms) }}</n-tag>
              <span v-if="current.perms !== 'edit'" class="muted note">{{ t('groups.viewOnly') }}</span>
            </span>
            <router-link :to="{ name: 'groups' }" class="back">← {{ t('groups.back') }}</router-link>
          </div>
          <div class="usage"><usage-bar :used="current.used" :quota="current.quotaBytes" /></div>
        </n-alert>
        <div v-else-if="!loading" class="surface gone">
          <n-empty :description="t('groups.notFound')">
            <template #extra><router-link :to="{ name: 'groups' }" class="back">← {{ t('groups.back') }}</router-link></template>
          </n-empty>
        </div>
      </div>
      <!-- the rights come with each listing: the group's folder is a space of its own -->
      <file-browser v-if="current" :key="current.id" :space="current.space" />
    </template>

    <!-- the list -->
    <template v-else>
      <page-header :title="t('groups.title')" :description="t('groups.subtitle')">
        <template #actions>
        <n-button :loading="loading" @click="load"><template #icon><n-icon :component="RefreshOutline" /></template>{{ t('common.refresh') }}</n-button>
        </template>
      </page-header>
      <list-panel :loading="loading" :count="items.length" :empty="t('groups.none')">
        <list-row v-for="g in items" :key="g.id" data-testid="group-row" :to="{ name: 'groups', params: { id: g.id } }">
          <template #icon><n-icon :component="PeopleCircleOutline" size="28" color="var(--folder)" /></template>
          <template #title>{{ g.name }}</template>
          <template #sub><usage-bar :used="g.used" :quota="g.quotaBytes" /></template>
          <template #actions>
            <n-tag size="small" round :bordered="false" :type="g.perms === 'edit' ? 'success' : 'default'">{{ permLabel(g.perms) }}</n-tag>
            <n-button size="small" type="primary" secondary @click="router.push({ name: 'groups', params: { id: g.id } })">
              <template #icon><n-icon :component="FolderOpenOutline" /></template>{{ t('groups.open') }}
            </n-button>
          </template>
        </list-row>
      </list-panel>
    </template>
  </div>
</template>

<script setup>
import PageHeader from '../components/PageHeader.vue'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { NAlert, NButton, NEmpty, NIcon, NSkeleton, NTag } from 'naive-ui'
import { FolderOpenOutline, PeopleCircleOutline, RefreshOutline } from '@vicons/ionicons5'
import { api } from '../api'
import FileBrowser from '../components/FileBrowser.vue'
import ListPanel from '../components/ListPanel.vue'
import ListRow from '../components/ListRow.vue'
import UsageBar from '../components/UsageBar.vue'
import { useFeedback } from '../composables'
import { useAppStore } from '../store'

const { t } = useI18n()
const fb = useFeedback()
const app = useAppStore()
const route = useRoute()
const router = useRouter()

const items = ref([])
const loading = ref(false)
const id = computed(() => (typeof route.params.id === 'string' ? route.params.id : ''))
const current = computed(() => items.value.find(g => g.id === id.value) || null)
const permLabel = p => (p === 'edit' ? t('groups.edit') : t('groups.view'))

async function load() {
  loading.value = true
  try {
    items.value = (await api.myGroups()).items
    app.groups = items.value
  } catch (e) { fb.fail(e) } finally { loading.value = false }
}

// the usage bar follows what the members upload while the page is open
let poll = null
onMounted(() => { load(); poll = setInterval(() => { if (!loading.value && document.visibilityState === 'visible') api.myGroups().then(r => { items.value = r.items; app.groups = r.items }).catch(() => {}) }, 15000) })
onBeforeUnmount(() => clearInterval(poll))
// a link from a notification: the list is read again so a group added a moment ago is there
watch(id, () => { if (id.value && !current.value) load() })
</script>

<style scoped>
.banner { margin-bottom: 14px; }
.banner-row { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 6px 16px; }
.banner-text { overflow-wrap: anywhere; min-width: 0; }
.note { display: block; font-size: 12.5px; margin-top: 2px; }
.usage { margin-top: 8px; max-width: 420px; }
.back { font-weight: 600; text-decoration: underline; text-underline-offset: 2px; color: inherit; white-space: nowrap; }
.gone { padding: 48px 16px; }
</style>
