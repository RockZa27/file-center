<template>
  <n-icon :component="icon" :size="size" :color="color" />
</template>

<script setup>
import { computed } from 'vue'
import { NIcon } from 'naive-ui'
import {
  ArchiveOutline, DocumentOutline, DocumentTextOutline, FilmOutline, Folder, ImageOutline, MusicalNotesOutline,
  CodeSlashOutline, GridOutline, EaselOutline,
} from '@vicons/ionicons5'
import { extOf } from '../utils'

const props = defineProps({ item: { type: Object, required: true }, size: { type: Number, default: 22 } })

const map = {
  image: [ImageOutline, '#10b981'],
  video: [FilmOutline, '#8b5cf6'],
  audio: [MusicalNotesOutline, '#ec4899'],
  pdf: [DocumentTextOutline, '#ef4444'],
  archive: [ArchiveOutline, '#f59e0b'],
  code: [CodeSlashOutline, '#0ea5e9'],
  sheet: [GridOutline, '#16a34a'],
  slide: [EaselOutline, '#ea580c'],
  doc: [DocumentTextOutline, '#2563eb'],
  text: [DocumentTextOutline, '#64748b'],
}
const groups = {
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif', 'svg'],
  video: ['mp4', 'webm', 'mkv', 'mov', 'avi'],
  audio: ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac'],
  pdf: ['pdf'],
  archive: ['zip', 'rar', '7z', 'gz', 'tar'],
  code: ['js', 'ts', 'json', 'html', 'css', 'vue', 'py', 'php', 'sh', 'sql', 'xml', 'yml', 'yaml'],
  sheet: ['xls', 'xlsx', 'csv'],
  slide: ['ppt', 'pptx'],
  doc: ['doc', 'docx', 'odt'],
  text: ['txt', 'md', 'log', 'ini'],
}

const resolved = computed(() => {
  if (props.item.type === 'dir') return [Folder, '#f59e0b']
  const e = extOf(props.item.name)
  const g = Object.keys(groups).find(k => groups[k].includes(e))
  return g ? map[g] : [DocumentOutline, '#94a3b8']
})
const icon = computed(() => resolved.value[0])
const color = computed(() => resolved.value[1])
</script>
