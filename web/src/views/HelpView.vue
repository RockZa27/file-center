<template>
  <div class="page">
    <page-header :title="t('nav.help')" />
    <div class="surface soon">{{ t('help.comingSoon') }}</div>
  </div>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import PageHeader from '../components/PageHeader.vue'

const { t } = useI18n()
</script>

<style scoped>
.soon { padding: 32px 20px; text-align: center; color: var(--muted); }
</style>
