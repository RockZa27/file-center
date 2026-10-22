<template>
  <div class="page">
    <page-header :title="t('nav.publicFolder')" :description="t('files.publicHint')">
      <div class="perms">
        <n-tag v-for="p in perms" :key="p" size="small" round :bordered="false" type="info">{{ t(`perm.${p}`) }}</n-tag>
      </div>
    </page-header>
    <file-browser space="public" />
  </div>
</template>

<script setup>
import PageHeader from '../components/PageHeader.vue'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { NTag } from 'naive-ui'
import FileBrowser from '../components/FileBrowser.vue'
import { useAppStore } from '../store'

const { t } = useI18n()
const app = useAppStore()
const perms = computed(() => app.spaces.public || [])
</script>

<style scoped>
.perms { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
</style>
