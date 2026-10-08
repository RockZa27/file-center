<template>
  <router-link :to="to" class="logo">
    <img v-if="app.config.logo" :src="`/api/branding/logo?v=${encodeURIComponent(app.config.logo)}`" :alt="app.appName" class="img">
    <template v-else>
      <span class="mark"><n-icon :component="FolderOpen" size="20" /></span>
      <span class="name">{{ app.appName }}</span>
    </template>
  </router-link>
</template>

<script setup>
import { NIcon } from 'naive-ui'
import { FolderOpen } from '@vicons/ionicons5'
import { useAppStore } from '../store'

defineProps({ to: { type: [String, Object], default: '/' } })
const app = useAppStore()
</script>

<style scoped>
.logo { display: inline-flex; align-items: center; gap: 10px; text-decoration: none; color: var(--text); min-width: 0; }
.img { max-height: 36px; max-width: 180px; object-fit: contain; }
.mark { width: 34px; height: 34px; border-radius: 10px; background: var(--primary); color: #fff; display: grid; place-items: center; flex: none; }
.name { font-weight: 600; font-size: 17px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
