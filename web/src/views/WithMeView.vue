<template>
  <div class="page">
    <!-- one shared folder -->
    <template v-if="id">
      <n-spin :show="loading && !current">
        <n-alert v-if="current" type="info" :show-icon="true" class="banner">
          <div class="banner-row">
            <span class="banner-text">
              {{ t('grants.viewing', { name: current.name, owner: ownerText(current) }) }}
              <n-tag size="small" round :bordered="false" :type="current.perms === 'edit' ? 'success' : 'default'">{{ permLabel(current.perms) }}</n-tag>
              <span v-if="current.viaGroup" class="via-pill">{{ t('groups.via', { name: current.viaGroup.name }) }}</span>
            </span>
            <router-link :to="{ name: 'with-me' }" class="back">← {{ t('grants.back') }}</router-link>
          </div>
        </n-alert>
        <div v-else-if="!loading" class="surface gone">
          <n-empty :description="t('grants.notFound')">
            <template #extra><router-link :to="{ name: 'with-me' }" class="back">← {{ t('grants.back') }}</router-link></template>
          </n-empty>
        </div>
      </n-spin>
      <!-- the rights come with each listing: the shared folder is a space of its own -->
      <file-browser v-if="current" :key="current.id" :space="current.space" />
    </template>

    <!-- the list -->
    <template v-else>
      <div class="page-header">
        <div><h1>{{ t('nav.withMe') }}</h1><p>{{ t('grants.withMeSubtitle') }}</p></div>
        <n-button :loading="loading" @click="load"><template #icon><n-icon :component="RefreshOutline" /></template>{{ t('common.refresh') }}</n-button>
      </div>
      <div class="surface list">
        <n-spin :show="loading && !items.length">
          <n-empty v-if="!loading && !items.length" :description="t('grants.withMeNone')" class="none" />
          <div v-for="g in items" :key="g.id" class="grant">
            <router-link :to="{ name: 'with-me', params: { id: g.id } }" class="grant-main">
              <n-icon :component="FolderOutline" size="26" color="#f59e0b" />
              <span class="grant-text">
                <span class="grant-name">{{ g.name }}</span>
                <span class="muted grant-meta">{{ t('grants.from', { name: ownerText(g) }) }} · {{ t('grants.since', { date: formatDate(g.createdAt) }) }}</span>
                <span v-if="g.viaGroup" class="via"><span class="via-pill">{{ t('groups.via', { name: g.viaGroup.name }) }}</span></span>
              </span>
            </router-link>
            <n-tag size="small" round :bordered="false" :type="g.perms === 'edit' ? 'success' : 'default'">{{ permLabel(g.perms) }}</n-tag>
            <div class="grant-actions">
              <n-button size="small" type="primary" secondary @click="open(g)"><template #icon><n-icon :component="FolderOpenOutline" /></template>{{ t('grants.open') }}</n-button>
              <n-button v-if="!g.viaGroup" size="small" quaternary type="error" @click="leave(g)"><template #icon><n-icon :component="ExitOutline" /></template>{{ t('grants.leave') }}</n-button>
            </div>
          </div>
        </n-spin>
      </div>
    </template>
  </div>
</template>

<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { NAlert, NButton, NEmpty, NIcon, NSpin, NTag } from 'naive-ui'
import { ExitOutline, FolderOpenOutline, FolderOutline, RefreshOutline } from '@vicons/ionicons5'
import { api } from '../api'
import FileBrowser from '../components/FileBrowser.vue'
import { useFeedback } from '../composables'
import { formatDate } from '../utils'

const { t } = useI18n()
const fb = useFeedback()
const route = useRoute()
const router = useRouter()

const items = ref([])
const loading = ref(false)
const id = computed(() => (typeof route.params.id === 'string' ? route.params.id : ''))
const current = computed(() => items.value.find(g => g.id === id.value) || null)

const permLabel = p => (p === 'edit' ? t('grants.permEdit') : t('grants.permView'))
const ownerText = g => (g.ownerName && g.ownerName !== g.owner ? `${g.ownerName} (${g.owner})` : g.owner)

async function load() {
  loading.value = true
  try { items.value = (await api.grantsToMe()).items } catch (e) { fb.fail(e) } finally { loading.value = false }
}
const open = g => router.push({ name: 'with-me', params: { id: g.id } })

async function leave(g) {
  if (!(await fb.confirm({ title: t('grants.leaveTitle'), content: t('grants.leaveBody', { name: g.name, owner: ownerText(g) }), positive: t('grants.leave'), danger: true }))) return
  try { await api.deleteGrant(g.id); fb.ok(t('grants.left')) } catch (e) { fb.fail(e) }
  await load()
}

onMounted(load)
// a link from a notification, or the back link: the list is read again so it is never older than the visit
watch(id, () => { if (!current.value) load() })
</script>

<style scoped>
.banner { margin-bottom: 14px; }
.banner-row { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 6px 16px; }
.banner-text { overflow-wrap: anywhere; min-width: 0; }
.back { font-weight: 600; text-decoration: underline; text-underline-offset: 2px; color: inherit; white-space: nowrap; }
.gone { padding: 48px 16px; }
.list { padding: 4px 0; }
.none { padding: 48px 16px; }
.grant { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 14px; padding: 12px 16px; border-bottom: 1px solid var(--border); }
.grant:last-child { border-bottom: 0; }
.grant-main { display: flex; align-items: center; gap: 12px; flex: 1 1 220px; min-width: 0; color: inherit; text-decoration: none; }
.grant-text { display: flex; flex-direction: column; min-width: 0; }
.grant-name { font-weight: 600; overflow-wrap: anywhere; }
.grant-main:hover .grant-name { color: var(--primary); text-decoration: underline; }
.grant-meta { font-size: 12.5px; overflow-wrap: anywhere; }
.via { margin-top: 2px; }
/* a tag would not wrap: a group name can be long, and a phone has no hover */
.via-pill { display: inline-block; max-width: 100%; padding: 1px 10px; border-radius: 999px; font-size: 12.5px; background: var(--primary-soft); color: var(--primary); overflow-wrap: anywhere; }
.grant-actions { display: flex; gap: 6px; flex-wrap: wrap; }
</style>
