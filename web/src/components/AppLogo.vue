<template>
  <router-link :to="to" class="logo">
    <img v-if="app.config.logo && !failed" :src="`/api/branding/logo?v=${encodeURIComponent(app.config.logo)}`" :alt="app.appName" class="img" @error="failed = true" @load="onLoad">
    <template v-else>
      <span class="mark"><n-icon :component="FolderOpen" size="20" /></span>
      <span class="name">{{ app.appName }}</span>
    </template>
  </router-link>
</template>

<script setup>
import { ref, watch } from 'vue'
import { NIcon } from 'naive-ui'
import { FolderOpen } from '@vicons/ionicons5'
import { useAppStore } from '../store'

defineProps({ to: { type: [String, Object], default: '/' } })
const app = useAppStore()
// a logo that does not load (or has no size at all) must never take the name away with it
const failed = ref(false)
watch(() => app.config.logo, () => { failed.value = false })
function onLoad(e) { if (!e.target.clientWidth || !e.target.clientHeight) failed.value = true }
</script>

<style scoped>
.logo { display: inline-flex; align-items: center; gap: 10px; text-decoration: none; color: var(--text); min-width: 0; }
.img { height: 36px; width: auto; min-width: 8px; max-width: min(180px, 100%); object-fit: contain; display: block; }
.mark { width: 34px; height: 34px; border-radius: 10px; background: var(--primary); color: #fff; display: grid; place-items: center; flex: none; }
.name { font-weight: 600; font-size: 17px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
