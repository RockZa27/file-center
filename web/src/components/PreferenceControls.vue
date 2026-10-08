<template>
  <div class="prefs">
    <n-dropdown trigger="click" :options="themeOptions" @select="v => app.setTheme(v)">
      <n-button quaternary circle :title="t('nav.theme')">
        <template #icon><n-icon :component="icon" /></template>
      </n-button>
    </n-dropdown>
    <n-button quaternary size="small" class="lang" :title="t('nav.language')" @click="app.setLang(app.lang === 'th' ? 'en' : 'th')">
      {{ app.lang === 'th' ? 'EN' : 'ไทย' }}
    </n-button>
  </div>
</template>

<script setup>
import { computed, h } from 'vue'
import { useI18n } from 'vue-i18n'
import { NButton, NDropdown, NIcon } from 'naive-ui'
import { ContrastOutline, MoonOutline, SunnyOutline } from '@vicons/ionicons5'
import { useAppStore } from '../store'

const { t } = useI18n()
const app = useAppStore()
const icon = computed(() => ({ light: SunnyOutline, dark: MoonOutline, auto: ContrastOutline })[app.theme])
const themeOptions = computed(() => [
  { key: 'light', label: t('nav.themeLight'), icon: () => h(NIcon, { component: SunnyOutline }) },
  { key: 'dark', label: t('nav.themeDark'), icon: () => h(NIcon, { component: MoonOutline }) },
  { key: 'auto', label: t('nav.themeAuto'), icon: () => h(NIcon, { component: ContrastOutline }) },
])
</script>

<style scoped>
.prefs { display: flex; align-items: center; gap: 2px; }
.lang { font-weight: 600; }
</style>
