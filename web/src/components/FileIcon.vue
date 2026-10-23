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
  image: [ImageOutline, 'var(--ft-image)'],
  video: [FilmOutline, 'var(--ft-video)'],
  audio: [MusicalNotesOutline, 'var(--ft-audio)'],
  pdf: [DocumentTextOutline, 'var(--ft-pdf)'],
  archive: [ArchiveOutline, 'var(--ft-archive)'],
  code: [CodeSlashOutline, 'var(--ft-code)'],
  sheet: [GridOutline, 'var(--ft-sheet)'],
  slide: [EaselOutline, 'var(--ft-slide)'],
  doc: [DocumentTextOutline, 'var(--ft-doc)'],
  text: [DocumentTextOutline, 'var(--ft-text)'],
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
  if (props.item.type === 'dir') return [Folder, 'var(--folder)']
  const e = extOf(props.item.name)
  const g = Object.keys(groups).find(k => groups[k].includes(e))
  return g ? map[g] : [DocumentOutline, 'var(--ft-other)']
})
const icon = computed(() => resolved.value[0])
const color = computed(() => resolved.value[1])
</script>
