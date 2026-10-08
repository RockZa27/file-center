<template>
  <n-config-provider :theme="isDark ? darkTheme : null" :theme-overrides="overrides" :locale="locale === 'th' ? thTH : enUS" :date-locale="locale === 'th' ? dateThTH : dateEnUS">
    <n-global-style />
    <n-loading-bar-provider>
      <n-dialog-provider>
        <n-message-provider placement="bottom">
          <div v-if="app.failed" class="fatal">
            <n-result status="500" :title="t('common.cannotConnect')">
              <template #footer>
                <n-button type="primary" @click="reload">{{ t('common.refresh') }}</n-button>
              </template>
            </n-result>
          </div>
          <router-view v-else />
        </n-message-provider>
      </n-dialog-provider>
    </n-loading-bar-provider>
  </n-config-provider>
</template>

<script setup>
import { computed, watchEffect } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  NButton, NConfigProvider, NDialogProvider, NGlobalStyle, NLoadingBarProvider, NMessageProvider, NResult,
  darkTheme, dateEnUS, dateThTH, enUS, thTH, useOsTheme,
} from 'naive-ui'
import { useAppStore } from './store'
import { shade } from './utils'

const app = useAppStore()
const { t, locale } = useI18n()
const os = useOsTheme()

const isDark = computed(() => app.theme === 'dark' || (app.theme === 'auto' && os.value === 'dark'))
const font = "'IBM Plex Sans Thai', system-ui, -apple-system, 'Segoe UI', sans-serif"

const overrides = computed(() => {
  const p = app.primaryColor
  return {
    common: {
      primaryColor: p,
      primaryColorHover: shade(p, isDark.value ? 0.15 : -0.1),
      primaryColorPressed: shade(p, -0.2),
      primaryColorSuppl: shade(p, 0.15),
      fontFamily: font,
      borderRadius: '8px',
    },
    DataTable: { thFontWeight: '600' },
  }
})

watchEffect(() => {
  const root = document.documentElement
  root.dataset.theme = isDark.value ? 'dark' : 'light'
  root.lang = locale.value
  root.style.setProperty('--primary', app.primaryColor)
  root.style.setProperty('--primary-soft', shade(app.primaryColor, isDark.value ? -0.75 : 0.9))
  document.title = app.appName
})

const reload = () => window.location.reload()
</script>

<style scoped>
.fatal { min-height: 100vh; display: grid; place-items: center; padding: 16px; }
</style>
