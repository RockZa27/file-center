<template>
  <div class="page">
    <n-alert type="info" :show-icon="true" class="banner">
      <div class="banner-row">
        <span class="banner-text">{{ t('users.viewingFiles', { name: shownName }) }}</span>
        <router-link :to="{ name: 'users' }" class="back">← {{ t('users.backToUsers') }}</router-link>
      </div>
    </n-alert>
    <!-- `user:<name>` is read-only: the browser takes its rights from the listing -->
    <file-browser :key="username" :space="`user:${username}`" />
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import { NAlert } from 'naive-ui'
import { api } from '../api'
import FileBrowser from '../components/FileBrowser.vue'

const { t } = useI18n()
const route = useRoute()
const username = computed(() => String(route.params.username || ''))
const name = ref('')
// the display name when the list knows it, else the username
const shownName = computed(() => (name.value ? `${name.value} (${username.value})` : username.value))

onMounted(async () => {
  try { name.value = (await api.users()).users.find(u => u.username.toLowerCase() === username.value.toLowerCase())?.name || '' } catch { /* the browser shows the refusal */ }
})
</script>

<style scoped>
.banner { margin-bottom: 14px; }
.banner-row { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 6px 16px; }
.banner-text { overflow-wrap: anywhere; min-width: 0; }
.back { font-weight: 600; text-decoration: underline; text-underline-offset: 2px; color: inherit; white-space: nowrap; }
</style>
