<template>
  <public-shell>
    <template #actions>
      <n-button type="primary" @click="router.push({ name: 'login' })">
        <template #icon><n-icon :component="LogInOutline" /></template>
        {{ t('nav.login') }}
      </n-button>
    </template>
    <section class="hero">
      <h1>{{ app.config.welcomeTitle }}</h1>
      <p>{{ app.config.welcomeText }}</p>
    </section>
    <div class="wrap">
      <file-browser space="public" :empty-text="app.config.publicEmptyText" />
    </div>
  </public-shell>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { NButton, NIcon } from 'naive-ui'
import { LogInOutline } from '@vicons/ionicons5'
import PublicShell from '../components/PublicShell.vue'
import FileBrowser from '../components/FileBrowser.vue'
import { useAppStore } from '../store'

const { t } = useI18n()
const app = useAppStore()
const router = useRouter()
</script>

<style scoped>
.hero { padding: 40px 24px 28px; max-width: 1280px; margin: 0 auto; }
.hero h1 { margin: 0; font-size: 28px; font-weight: 600; }
.hero p { margin: 8px 0 0; color: var(--muted); max-width: 720px; line-height: 1.6; }
.wrap { max-width: 1280px; margin: 0 auto; padding: 0 24px 48px; }
@media (max-width: 768px) {
  .hero { padding: 24px 16px 16px; }
  .hero h1 { font-size: 22px; }
  .wrap { padding: 0 16px 32px; }
}
</style>
