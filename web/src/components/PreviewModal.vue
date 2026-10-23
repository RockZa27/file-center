<template>
  <n-modal :show="show" preset="card" :style="{ width: wide ? 'min(1240px, 96vw)' : 'min(980px, 96vw)' }" :title="item?.name" :bordered="false" class="preview-modal" @update:show="close">
    <template #header-extra>
      <div class="extra">
        <n-button v-if="officeMode" quaternary size="small" @click="toOffice">
          <template #icon><n-icon :component="officeMode === 'edit' ? CreateOutline : OpenOutline" /></template>{{ officeMode === 'edit' ? t('office.edit') : t('office.open') }}
        </n-button>
        <n-button v-if="app.user && item && !space.startsWith('user:')" quaternary circle :title="fav ? t('files.removeFavorite') : t('files.addFavorite')" @click="toggleFav">
          <template #icon><n-icon :component="fav ? Star : StarOutline" :color="fav ? 'var(--star)' : undefined" /></template>
        </n-button>
        <n-button v-if="item && isTextKind(kind)" quaternary size="small" @click="emit('versions', item)">
          <template #icon><n-icon :component="TimeOutline" /></template>{{ t('versions.menu') }}
        </n-button>
        <n-button v-if="canDownload && item" quaternary size="small" tag="a" :href="api.downloadUrl(space, item.path)">
          <template #icon><n-icon :component="DownloadOutline" /></template>{{ t('common.download') }}
        </n-button>
      </div>
    </template>
    <div v-if="item" class="stage" :class="{ fill: kind !== 'image' && kind !== 'video' && kind !== 'audio' }">
      <img v-if="kind === 'image'" :src="inlineUrl" :alt="item.name" class="media">
      <video v-else-if="kind === 'video'" :src="inlineUrl" controls class="media" />
      <audio v-else-if="kind === 'audio'" :src="inlineUrl" controls class="audio" />
      <iframe v-else-if="kind === 'pdf'" :src="inlineUrl" class="pdf" :title="item.name" />
      <text-editor v-else-if="isTextKind(kind)" ref="editor" :key="`${item.path}#${opened}`" :space="space" :item="item" :can-edit="canEdit" :siblings="siblings" @saved="emit('saved')" />
      <document-preview v-else-if="kind === 'docx' || kind === 'sheet' || kind === 'slides'" :key="`${item.path}#${opened}`" :space="space" :item="item" :can-download="canDownload" />
      <div v-else class="muted">{{ t('files.noPreview') }}</div>
    </div>
    <template #footer>
      <div class="foot">
        <div class="nav">
          <n-button quaternary circle :title="t('preview.previous')" :disabled="!prev" @click="go(prev)"><template #icon><n-icon :component="ChevronBackOutline" /></template></n-button>
          <span class="muted pos">{{ position }}</span>
          <n-button quaternary circle :title="t('preview.next')" :disabled="!next" @click="go(next)"><template #icon><n-icon :component="ChevronForwardOutline" /></template></n-button>
        </div>
        <n-button v-if="isTextKind(kind) && canEdit && editor" type="primary" :loading="editor.saving" :disabled="!editor.dirty" @click="editor.save()">
          <template #icon><n-icon :component="SaveOutline" /></template>{{ t('common.save') }}
        </n-button>
      </div>
    </template>
  </n-modal>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { NButton, NIcon, NModal } from 'naive-ui'
import { ChevronBackOutline, ChevronForwardOutline, CreateOutline, DownloadOutline, OpenOutline, SaveOutline, Star, StarOutline, TimeOutline } from '@vicons/ionicons5'
import { api } from '../api'
import { useFeedback } from '../composables'
import { useAppStore } from '../store'
import { isTextKind, kindOf } from '../utils'
import DocumentPreview from './DocumentPreview.vue'
import TextEditor from './TextEditor.vue'

const props = defineProps({
  show: Boolean, space: String, item: Object, siblings: { type: Array, default: () => [] },
  canEdit: Boolean, canDownload: Boolean,
  /** name → 'edit' | 'view' | null: whether ONLYOFFICE opens this file (see officeModeFor) */
  officeModeOf: { type: Function, default: () => null },
})
const emit = defineEmits(['update:show', 'saved', 'office', 'versions'])
const app = useAppStore()
const { t } = useI18n()
const fb = useFeedback()

const current = ref(null)
const fav = computed(() => !!current.value && app.isFavorite(props.space, current.value.path))
async function toggleFav() {
  try { await app.toggleFavorite(props.space, current.value.path) } catch (e) { fb.fail(e) }
}
const editor = ref(null)
// bumped when the same file is opened again: the editor starts over, so discarded edits are gone
const opened = ref(0)

const item = computed(() => current.value)
const kind = computed(() => (item.value ? kindOf(item.value.name) : 'other'))
const wide = computed(() => kind.value !== 'image' && kind.value !== 'video' && kind.value !== 'audio')
const officeMode = computed(() => (item.value ? props.officeModeOf(item.value.name) : null))
const inlineUrl = computed(() => api.downloadUrl(props.space, item.value.path, true))
const list = computed(() => props.siblings.filter(s => s.type === 'file' && kindOf(s.name) !== 'other'))
const index = computed(() => list.value.findIndex(s => s.path === item.value?.path))
const prev = computed(() => (index.value > 0 ? list.value[index.value - 1] : null))
const next = computed(() => (index.value >= 0 && index.value < list.value.length - 1 ? list.value[index.value + 1] : null))
const position = computed(() => (index.value >= 0 ? `${index.value + 1} / ${list.value.length}` : ''))

watch(() => [props.show, props.item], () => {
  if (!props.show || !props.item) return
  current.value = props.item
  opened.value++
}, { immediate: true })

async function go(it) {
  if (!it) return
  if (!(await leave())) return
  current.value = it
}

async function leave() {
  if (!editor.value?.dirty) return true
  return fb.confirm({ title: t('files.unsaved'), content: t('files.unsavedText'), positive: t('files.discard'), danger: true })
}

async function close(v) {
  if (!v && !(await leave())) return
  emit('update:show', v)
}

async function toOffice() {
  if (!(await leave())) return
  emit('update:show', false)
  emit('office', item.value, officeMode.value)
}
</script>

<style scoped>
.extra { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; justify-content: flex-end; }
.stage { display: grid; place-items: center; min-height: 240px; }
.stage.fill { display: block; }
.media { max-width: 100%; max-height: 70vh; border-radius: 8px; }
.audio { width: 100%; }
.pdf { width: 100%; height: 70vh; border: 0; border-radius: 8px; background: var(--surface-2); }
.foot { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
.nav { display: flex; align-items: center; gap: 4px; }
.pos { font-size: 13px; min-width: 56px; text-align: center; }
</style>

<style>
/* the modal sits outside this component: a long file name takes the whole first line, the buttons go below it */
.n-card.preview-modal > .n-card-header { flex-wrap: wrap; row-gap: 6px; }
.n-card.preview-modal > .n-card-header > .n-card-header__main { flex: 1 1 260px; min-width: 0; overflow-wrap: anywhere; }
.n-card.preview-modal > .n-card-header > .n-card-header__extra { margin-left: auto; }
</style>
