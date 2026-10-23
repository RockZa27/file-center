<template>
  <div class="system">
    <!-- risky or odd .env values; a critical one is red. Closing one hides it until this tab is closed -->
    <div v-if="shown.length" class="warns" data-tour="config-warnings">
      <n-alert v-for="w in shown" :key="w.code" :type="w.severity === 'critical' ? 'error' : 'warning'" closable class="warn" @close="dismiss(w.code)">{{ w.message }}</n-alert>
    </div>
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
import { computed, inject, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import { NAlert, NBadge, NIcon } from 'naive-ui'
import { api } from '../api'
import { ArchiveOutline, CloudUploadOutline, DocumentTextOutline, FileTrayFullOutline, SettingsOutline } from '@vicons/ionicons5'

const { t, locale } = useI18n()
const route = useRoute()
// AppLayout already reads the status warnings every few minutes: no polling here
const updateAvailable = inject('updateAvailable', computed(() => false))

// the server writes the texts in the page language: ask again when it changes
const KEY = 'fc.dismissedConfigWarnings'
const warnings = ref([])
const dismissed = ref([])
try { dismissed.value = JSON.parse(sessionStorage.getItem(KEY) || '[]') } catch { /* private mode */ }
const shown = computed(() => warnings.value.filter(w => !dismissed.value.includes(w.code)).sort((a, b) => (b.severity === 'critical') - (a.severity === 'critical')))
function dismiss(code) {
  dismissed.value = [...dismissed.value, code]
  try { sessionStorage.setItem(KEY, JSON.stringify(dismissed.value)) } catch { /* private mode */ }
}
async function loadWarnings() {
  try { warnings.value = (await api.configWarnings()).items } catch { /* the banner is a nicety */ }
}
onMounted(loadWarnings)
watch(locale, loadWarnings)

const tabs = computed(() => [
  { name: 'settings', tour: 'sys-settings', label: t('nav.settings'), icon: SettingsOutline },
  { name: 'backup', tour: 'sys-backup', label: t('nav.backup'), icon: ArchiveOutline },
  { name: 'update', tour: 'sys-update', label: t('nav.update'), icon: CloudUploadOutline, dot: updateAvailable.value },
  { name: 'logs', tour: 'sys-logs', label: t('nav.logs'), icon: DocumentTextOutline },
  { name: 'trash', tour: 'sys-trash', label: t('nav.trashAll'), icon: FileTrayFullOutline },
])
</script>

<style scoped>
.warns { display: flex; flex-direction: column; gap: 8px; padding: 16px 24px 0; max-width: 1280px; margin: 0 auto; }
.warn { overflow-wrap: anywhere; }
@media (max-width: 768px) { .warns { padding: 12px 16px 0; } }
.sys-tabs { display: flex; gap: 4px; margin: 0 0 20px; border-bottom: 1px solid var(--border); overflow-x: auto; scrollbar-width: thin; }
.sys-tab { display: inline-flex; align-items: center; gap: 6px; padding: 10px 14px; white-space: nowrap; color: var(--muted); text-decoration: none; font-size: 14.5px; border-bottom: 2px solid transparent; margin-bottom: -1px; flex: none; }
.sys-tab:hover { color: var(--text); }
.sys-tab.router-link-active { color: var(--primary); font-weight: 600; border-bottom-color: var(--primary); }
</style>
