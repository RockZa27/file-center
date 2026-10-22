<template>
  <div class="system">
    <nav class="sys-tabs" role="tablist" :aria-label="t('nav.system')">
      <router-link v-for="tb in tabs" :key="tb.name" :to="{ name: tb.name }" role="tab" class="sys-tab" :aria-selected="route.name === tb.name" :data-tour="tb.tour">
        <n-icon :component="tb.icon" size="17" />
        <span>{{ tb.label }}</span>
        <n-badge v-if="tb.dot" dot type="info" :title="t('system.updateAvailable')" />
      </router-link>
    </nav>
    <router-view />
  </div>
</template>

<script setup>
import { computed, inject } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import { NBadge, NIcon } from 'naive-ui'
import { ArchiveOutline, CloudUploadOutline, DocumentTextOutline, FileTrayFullOutline, SettingsOutline } from '@vicons/ionicons5'

const { t } = useI18n()
const route = useRoute()
// AppLayout already reads the status warnings every few minutes: no polling here
const updateAvailable = inject('updateAvailable', computed(() => false))

const tabs = computed(() => [
  { name: 'settings', tour: 'sys-settings', label: t('nav.settings'), icon: SettingsOutline },
  { name: 'backup', tour: 'sys-backup', label: t('nav.backup'), icon: ArchiveOutline },
  { name: 'update', tour: 'sys-update', label: t('nav.update'), icon: CloudUploadOutline, dot: updateAvailable.value },
  { name: 'logs', tour: 'sys-logs', label: t('nav.logs'), icon: DocumentTextOutline },
  { name: 'trash', tour: 'sys-trash', label: t('nav.trashAll'), icon: FileTrayFullOutline },
])
</script>

<style scoped>
.sys-tabs { display: flex; gap: 4px; margin: 0 0 20px; border-bottom: 1px solid var(--border); overflow-x: auto; scrollbar-width: thin; }
.sys-tab { display: inline-flex; align-items: center; gap: 6px; padding: 10px 14px; white-space: nowrap; color: var(--muted); text-decoration: none; font-size: 14.5px; border-bottom: 2px solid transparent; margin-bottom: -1px; flex: none; }
.sys-tab:hover { color: var(--text); }
.sys-tab.router-link-active { color: var(--primary); font-weight: 600; border-bottom-color: var(--primary); }
</style>
